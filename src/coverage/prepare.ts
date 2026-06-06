import { collectPaths, resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import type { CoverageRoot } from "../staging/synthesizer.ts";
import { synthesize } from "../staging/synthesizer.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import { hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { BUILD_MANIFEST_VERSION, readBuildManifest, writeBuildManifest } from "./build-manifest.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";
import { cleanupDeletedFiles, detectDeletedFiles, prepareShadowRoot } from "./shadow-root.ts";

const COVERAGE_DIR = ".jest-roblox/coverage";
const COVERAGE_MANIFEST = "coverage-manifest.json";
const BUILD_MANIFEST = "build-manifest.json";

export interface PrepareCoverageResult {
	manifest: CoverageManifest;
	placeFile: string;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	buildId: string;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
}

export function collectLuauRootsFromRojo(
	project: RojoProject,
	config: ResolvedConfig,
): Array<string> {
	const paths: Array<string> = [];
	collectPaths(project.tree, paths);

	const ignorePatterns = config.coveragePathIgnorePatterns;
	// contains: true so bare strings like "rojo-sync" match "rojo-sync/rbxts",
	// mirroring Jest's regex-based coveragePathIgnorePatterns behavior.
	const isIgnored = picomatch(ignorePatterns, { contains: true });

	return paths.filter((directoryPath) => {
		if (!fs.existsSync(directoryPath)) {
			return false;
		}

		// Only directories can be coverage roots (skip single-file $path entries)
		if (!fs.statSync(directoryPath).isDirectory()) {
			return false;
		}

		if (isIgnored(directoryPath)) {
			return false;
		}

		return containsLuauFiles(directoryPath);
	});
}

export function resolveLuauRoots(config: ResolvedConfig): Array<string> {
	return resolveLuauRootsWithRojo(config);
}

export function prepareCoverage(
	config: ResolvedConfig,
	beforeBuild?: (shadowDirectory: string) => boolean,
): PrepareCoverageResult {
	const rojoProjectPath = findRojoProject(config);
	const luauRoots = resolveLuauRootsWithRojo(config, rojoProjectPath);

	validateRelativeRoots(luauRoots);

	const manifestPath = path.join(COVERAGE_DIR, COVERAGE_MANIFEST);
	const buildManifestPath = path.join(COVERAGE_DIR, BUILD_MANIFEST);
	const previousManifest = loadCoverageManifest(manifestPath);
	const useIncremental = canUseIncremental(previousManifest, config);

	if (!useIncremental && fs.existsSync(COVERAGE_DIR)) {
		fs.rmSync(COVERAGE_DIR, { recursive: true });
	}

	const allFiles: Record<string, InstrumentedFileRecord> = {};
	const allNonInstrumented: Record<string, NonInstrumentedFileRecord> = {};
	const coverageRoots: Array<CoverageRoot> = [];
	let hasChanges = !useIncremental;

	for (const luauRoot of luauRoots) {
		const shadowDirectory = normalizeWindowsPath(path.join(COVERAGE_DIR, luauRoot));
		const result = prepareShadowRoot({
			luauRoot,
			previousManifest,
			shadowDir: shadowDirectory,
			useIncremental,
		});

		if (result.changed) {
			hasChanges = true;
		}

		Object.assign(allFiles, result.files);
		Object.assign(allNonInstrumented, result.nonInstrumentedFiles);
		coverageRoots.push({
			luauRoot: result.luauRoot,
			shadowDir: normalizeWindowsPath(path.resolve(result.shadowDir)),
		});
	}

	if (useIncremental && previousManifest !== undefined) {
		const deleted = detectDeletedFiles(previousManifest, allFiles);
		cleanupDeletedFiles(deleted);

		if (deleted.length > 0) {
			hasChanges = true;
		}
	}

	if (beforeBuild !== undefined) {
		const extraChanges = beforeBuild(COVERAGE_DIR);
		if (extraChanges) {
			hasChanges = true;
		}
	}

	const placeFile = path.join(COVERAGE_DIR, "game.rbxl");

	// Incremental no-change short-circuit: reuse the prior place only if it is
	// still on disk and its bytes match the prior build manifest's record. A
	// missing or drifted artifact (e.g. an interrupted prior build) falls
	// through to a full rebuild rather than publishing a manifest that points
	// at a stale or absent `.rbxl`.
	if (
		!hasChanges &&
		previousManifest?.placeFilePath !== undefined &&
		priorPlaceIsReusable(previousManifest.placeFilePath, buildManifestPath)
	) {
		return { manifest: previousManifest, placeFile: previousManifest.placeFilePath };
	}

	// Build the `.rbxl` first, then hash it, then publish both manifests. The
	// order matters: a failed `buildRojoProject` throws before any manifest is
	// written, so an interrupted run never leaves a manifest claiming an
	// artifact that isn't on disk.
	buildRojoProject(rojoProjectPath, config.rootDir, coverageRoots, placeFile);

	const buildId = crypto.randomUUID();
	const manifest = buildAndWriteManifest({
		allFiles,
		buildId,
		luauRoots,
		manifestPath,
		nonInstrumentedFiles: allNonInstrumented,
		placeFile,
	});
	writeBuildManifest(buildManifestPath, {
		buildId,
		cleanPlace: { hash: hashFile(placeFile), path: placeFile },
		files: toBuildManifestFiles(allFiles),
		generatedAt: manifest.generatedAt,
		projects: [],
		version: BUILD_MANIFEST_VERSION,
	});

	return { manifest, placeFile };
}

function containsLuauFiles(directoryPath: string): boolean {
	const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && entry.name.endsWith(".luau")) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(path.join(directoryPath, entry.name));
		}

		return false;
	});
}

function findRojoProject(config: ResolvedConfig): string {
	if (config.rojoProject !== undefined) {
		return config.rojoProject;
	}

	const defaultPath = path.join(config.rootDir, "default.project.json");
	if (fs.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fs.readdirSync(config.rootDir, "utf-8");
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	if (projectFile !== undefined) {
		return path.join(config.rootDir, projectFile);
	}

	throw new Error(
		"No Rojo project found. Set rojoProject in config or add a .project.json file.",
	);
}

function resolveLuauRootsWithRojo(config: ResolvedConfig, rojoProjectPath?: string): Array<string> {
	if (config.luauRoots !== undefined && config.luauRoots.length > 0) {
		return config.luauRoots;
	}

	// Auto-detect from Rojo project
	try {
		const resolvedPath = rojoProjectPath ?? findRojoProject(config);
		const validated = rojoProjectSchema(JSON.parse(fs.readFileSync(resolvedPath, "utf-8")));
		if (validated instanceof type.errors) {
			throw new Error(validated.summary);
		}

		const rojoProject = validated;
		const resolved = {
			...rojoProject,
			tree: resolveNestedProjects(rojoProject.tree, path.dirname(resolvedPath)),
		};
		const roots = collectLuauRootsFromRojo(resolved, config);
		if (roots.length > 0) {
			return roots;
		}
	} catch (err) {
		// Expected: no project file found → fall through to tsconfig.
		// Unexpected: malformed JSON → surface to help debugging.
		if (err instanceof SyntaxError) {
			throw new Error(`Malformed Rojo project JSON: ${err.message}`, { cause: err });
		}
	}

	const tsconfig = getTsconfig(config.rootDir) ?? undefined;
	const outDirectory = tsconfig?.config.compilerOptions?.outDir;
	if (outDirectory !== undefined) {
		return [outDirectory];
	}

	throw new Error(
		"Could not determine luauRoots. Set luauRoots in config or ensure tsconfig has outDir.",
	);
}

function priorPlaceIsReusable(placeFilePath: string, buildManifestPath: string): boolean {
	if (!fs.existsSync(placeFilePath)) {
		return false;
	}

	// A prior build manifest validates the cached artifacts: `readBuildManifest`
	// re-hashes the clean place (and sources), so any drift or corruption yields
	// a non-ok result and forces a rebuild. Pre-BuildManifest caches (coverage
	// manifest only) have no build manifest yet, so the existence check above is
	// the only gate — keeping the no-change path working across the v3 upgrade.
	const previous = readBuildManifest(buildManifestPath);
	if (previous.kind === "missing") {
		return true;
	}

	if (previous.kind !== "ok") {
		process.stderr.write(
			`Warning: Previous build manifest is unusable (${previous.kind}); rebuilding place.\n`,
		);
		return false;
	}

	return true;
}

function toBuildManifestFiles(
	allFiles: Record<string, InstrumentedFileRecord>,
): Record<string, { sourceHash: string }> {
	return Object.fromEntries(
		Object.entries(allFiles).map(([key, record]) => [key, { sourceHash: record.sourceHash }]),
	);
}

function validateRelativeRoots(luauRoots: Array<string>): void {
	for (const root of luauRoots) {
		if (path.isAbsolute(root)) {
			throw new Error(
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		}
	}
}

function buildRojoProject(
	rojoProjectPath: string,
	packageDirectory: string,
	coverageRoots: Array<CoverageRoot>,
	placeFile: string,
): void {
	const synthesized = synthesize({
		packages: [
			{
				name: "jest-roblox-coverage",
				coverageRoots,
				packageDirectory: path.resolve(packageDirectory),
				rojoProjectPath: path.resolve(rojoProjectPath),
			},
		],
		wrap: false,
	});

	const rewrittenProjectPath = path.join(COVERAGE_DIR, path.basename(rojoProjectPath));
	fs.writeFileSync(rewrittenProjectPath, synthesized);
	buildWithRojo(rewrittenProjectPath, placeFile);
}

function loadCoverageManifest(manifestPath: string): CoverageManifest | undefined {
	const result = readManifest(manifestPath);
	switch (result.kind) {
		case "invalid": {
			process.stderr.write(
				`Warning: Previous coverage manifest is invalid (cache discarded): ${result.summary}\n`,
			);
			return undefined;
		}
		case "malformed-json": {
			process.stderr.write(
				"Warning: Previous coverage manifest is malformed JSON (cache discarded)\n",
			);
			return undefined;
		}
		case "missing":
		case "version-mismatch": {
			return undefined;
		}
		case "ok": {
			return result.manifest;
		}
	}
}

function canUseIncremental(
	previousManifest: CoverageManifest | undefined,
	config: ResolvedConfig,
): boolean {
	if (!config.coverageCache) {
		return false;
	}

	if (previousManifest === undefined) {
		return false;
	}

	if (previousManifest.instrumenterVersion !== INSTRUMENTER_VERSION) {
		return false;
	}

	return true;
}

function buildAndWriteManifest(options: WriteManifestOptions): CoverageManifest {
	const { allFiles, buildId, luauRoots, manifestPath, nonInstrumentedFiles, placeFile } = options;

	const manifest: CoverageManifest = {
		buildId,
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
		nonInstrumentedFiles,
		placeFilePath: placeFile,
		shadowDir: COVERAGE_DIR,
		version: MANIFEST_VERSION,
	};

	writeManifest(manifestPath, manifest);

	return manifest;
}
