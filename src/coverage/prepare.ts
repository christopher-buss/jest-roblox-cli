import { collectPaths, resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";
import type { RojoProject, RootEntry } from "./rojo-rewriter.ts";
import { rewriteRojoProject } from "./rojo-rewriter.ts";
import { cleanupDeletedFiles, detectDeletedFiles, prepareShadowRoot } from "./shadow-root.ts";

const COVERAGE_DIR = ".jest-roblox/coverage";

export interface PrepareCoverageResult {
	manifest: CoverageManifest;
	placeFile: string;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
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

	const manifestPath = path.join(COVERAGE_DIR, "manifest.json");
	const previousManifest = loadCoverageManifest(manifestPath);
	const useIncremental = canUseIncremental(previousManifest, config);

	if (!useIncremental && fs.existsSync(COVERAGE_DIR)) {
		fs.rmSync(COVERAGE_DIR, { recursive: true });
	}

	const allFiles: Record<string, InstrumentedFileRecord> = {};
	const allNonInstrumented: Record<string, NonInstrumentedFileRecord> = {};
	const roots: Array<RootEntry> = [];
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
		roots.push({
			luauRoot: result.luauRoot,
			relocatedShadowDirectory: normalizeWindowsPath(
				path.relative(COVERAGE_DIR, result.shadowDir),
			),
			shadowDir: result.shadowDir,
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
	const manifest = buildAndWriteManifest({
		allFiles,
		luauRoots,
		manifestPath,
		nonInstrumentedFiles: allNonInstrumented,
		placeFile,
	});

	if (!hasChanges && previousManifest?.placeFilePath !== undefined) {
		return { manifest, placeFile: previousManifest.placeFilePath };
	}

	buildRojoProject(rojoProjectPath, roots, placeFile);

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
		const rojoProject = JSON.parse(
			fs.readFileSync(resolvedPath, "utf-8"),
		) as unknown as RojoProject;

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
	roots: Array<RootEntry>,
	placeFile: string,
): void {
	const rojoProjectRaw = rojoProjectSchema(JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8")));
	if (rojoProjectRaw instanceof type.errors) {
		throw new Error(`Malformed Rojo project JSON: ${rojoProjectRaw.toString()}`);
	}

	const projectRelocation = normalizeWindowsPath(
		path.relative(COVERAGE_DIR, path.dirname(rojoProjectPath)),
	);

	const resolved = {
		...rojoProjectRaw,
		tree: resolveNestedProjects(rojoProjectRaw.tree, path.dirname(rojoProjectPath)),
	};
	const rewritten = rewriteRojoProject(resolved, { projectRelocation, roots });
	const rewrittenProjectPath = path.join(COVERAGE_DIR, path.basename(rojoProjectPath));

	fs.writeFileSync(rewrittenProjectPath, JSON.stringify(rewritten, undefined, "\t"));
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
	const { allFiles, luauRoots, manifestPath, nonInstrumentedFiles, placeFile } = options;

	const manifest: CoverageManifest = {
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
