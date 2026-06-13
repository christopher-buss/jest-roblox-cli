import { collectPaths, resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import { buildPlace } from "../staging/place-builder.ts";
import type { CoverageRoot } from "../staging/synthesizer.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import { hashFile } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type {
	BuildManifestArtifact,
	BuildManifestFileRecord,
	BuildManifestProject,
	CoverageArtifacts,
} from "./build-manifest.ts";
import { BUILD_MANIFEST_FILE, readBuildManifest, toBuildManifestFiles } from "./build-manifest.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";
import { computeRojoInputsHash } from "./rojo-inputs.ts";
import { cleanupDeletedFiles, detectDeletedFiles, prepareShadowRoot } from "./shadow-root.ts";

const COVERAGE_DIR = ".jest-roblox/coverage";
const COVERAGE_MANIFEST = "coverage-manifest.json";

/** Where the coverage path publishes its sibling manifests (cwd-relative). */
export const COVERAGE_MANIFEST_PATH: string = path.join(COVERAGE_DIR, COVERAGE_MANIFEST);
export const COVERAGE_BUILD_MANIFEST_PATH: string = path.join(COVERAGE_DIR, BUILD_MANIFEST_FILE);

export interface PrepareCoverageResult {
	/** Shared UUID for the sibling Build + Coverage manifests. */
	buildId: string;
	/** The instrumented place this run resolved (built fresh or reused). */
	coveragePlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, for the caller's Build Manifest. */
	files: Record<string, BuildManifestFileRecord>;
	manifest: CoverageManifest;
	placeFile: string;
	/**
	 * `true` when the place was rebuilt this run. `false` on the incremental
	 * no-change short-circuit, so an entry point can skip rewriting an identical
	 * Build Manifest.
	 */
	rebuilt: boolean;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	buildId: string;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
	rojoInputsHash: string;
}

interface PriorPlaceReuse {
	/**
	 * The prior manifest's validated coverage place, when a build manifest exists.
	 * `readBuildManifest` already re-hashed it, so the caller reuses this rather
	 * than hashing the same `.rbxl` a second time. Absent for pre-BuildManifest
	 * caches (coverage manifest only).
	 */
	coveragePlace?: BuildManifestArtifact;
	reusable: boolean;
}

interface ReuseCoverageOptions {
	buildManifestPath: string;
	files: Record<string, BuildManifestFileRecord>;
	hasChanges: boolean;
	previousManifest: CoverageManifest | undefined;
}

/** Project the coverage result down to the record an entry point emits. */
export function toCoverageArtifacts(
	result: PrepareCoverageResult,
	projects: Array<BuildManifestProject>,
): CoverageArtifacts {
	return {
		buildId: result.buildId,
		coveragePlace: result.coveragePlace,
		files: result.files,
		generatedAt: result.manifest.generatedAt,
		projects,
		rebuilt: result.rebuilt,
	};
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

export function findRojoProject(config: ResolvedConfig): string {
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

	const { hash: rojoInputsHash, resolved: inputsResolved } = resolveRojoInputsHash(
		config,
		rojoProjectPath,
		luauRoots,
	);

	const manifestPath = path.join(COVERAGE_DIR, COVERAGE_MANIFEST);
	const buildManifestPath = path.join(COVERAGE_DIR, BUILD_MANIFEST_FILE);
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

	// A non-luauRoot rojo input changed — the shadow diff can't see those, so
	// force a rebuild rather than reuse a stale place built from the old include/
	// or vendored sources. When the inputs couldn't be hashed the check is
	// skipped (not forced): a project too broken to hash would also fail the
	// rebuild's own parse, so preserve the prior reuse behavior instead of
	// converting it into a hard failure.
	if (useIncremental && inputsResolved && previousManifest?.rojoInputsHash !== rojoInputsHash) {
		hasChanges = true;
	}

	const placeFile = path.join(COVERAGE_DIR, "game.rbxl");
	const files = toBuildManifestFiles(allFiles);

	const reused = reuseCoverageResult({ buildManifestPath, files, hasChanges, previousManifest });
	if (reused !== undefined) {
		process.stderr.write(
			`Reusing cached coverage place (built ${reused.manifest.generatedAt})\n`,
		);
		return reused;
	}

	// Build the `.rbxl` first, then hash it. The order matters: a failed
	// `buildRojoProject` throws before the coverage manifest is written, so an
	// interrupted run never leaves a manifest claiming an artifact that isn't on
	// disk. The caller owns Build Manifest emission (it alone knows the full
	// place set), keeping that write a single atomic operation.
	const coveragePlace = buildRojoProject(
		rojoProjectPath,
		config.rootDir,
		coverageRoots,
		placeFile,
	);

	const buildId = crypto.randomUUID();
	const manifest = buildAndWriteManifest({
		allFiles,
		buildId,
		luauRoots,
		manifestPath,
		nonInstrumentedFiles: allNonInstrumented,
		placeFile,
		rojoInputsHash,
	});

	return { buildId, coveragePlace, files, manifest, placeFile, rebuilt: true };
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
): BuildManifestArtifact {
	return buildPlace({
		packages: [
			{
				name: "jest-roblox-coverage",
				coverageRoots,
				packageDirectory: path.resolve(packageDirectory),
				rojoProjectPath: path.resolve(rojoProjectPath),
			},
		],
		placeFile,
		projectFile: path.join(COVERAGE_DIR, path.basename(rojoProjectPath)),
		wrap: false,
	});
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

/**
 * Hash the rojo build inputs the per-luauRoot shadow diff never sees (include/,
 * vendored @rbxts, assets, the project files). Runs regardless of how luauRoots
 * resolved. A malformed/circular project throws; degrade to `resolved: false` so
 * the caller skips the inputs check (a project too broken to hash would also
 * fail the rebuild's own parse) rather than hard-failing a working run.
 */
function resolveRojoInputsHash(
	config: ResolvedConfig,
	rojoProjectPath: string,
	luauRoots: Array<string>,
): { hash: string; resolved: boolean } {
	try {
		const hash = computeRojoInputsHash({
			luauRoots,
			rojoProjectPath,
			rootDirectory: config.rootDir,
		});
		return { hash, resolved: true };
	} catch (err) {
		process.stderr.write(`Warning: could not hash rojo build inputs: ${String(err)}\n`);
		return { hash: "", resolved: false };
	}
}

function buildAndWriteManifest(options: WriteManifestOptions): CoverageManifest {
	const {
		allFiles,
		buildId,
		luauRoots,
		manifestPath,
		nonInstrumentedFiles,
		placeFile,
		rojoInputsHash,
	} = options;

	const manifest: CoverageManifest = {
		buildId,
		files: allFiles,
		generatedAt: new Date().toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots,
		nonInstrumentedFiles,
		placeFilePath: placeFile,
		rojoInputsHash,
		shadowDir: COVERAGE_DIR,
		version: MANIFEST_VERSION,
	};

	writeManifest(manifestPath, manifest);

	return manifest;
}

function priorPlaceIsReusable(placeFilePath: string, buildManifestPath: string): PriorPlaceReuse {
	if (!fs.existsSync(placeFilePath)) {
		return { reusable: false };
	}

	// A prior build manifest validates the cached artifacts: `readBuildManifest`
	// re-hashes the coverage place (and sources), so any drift or corruption
	// yields a non-ok result and forces a rebuild. Pre-BuildManifest caches
	// (coverage manifest only) have no build manifest yet, so the existence check
	// above is the only gate — keeping the no-change path working across
	// upgrades.
	const previous = readBuildManifest(buildManifestPath);
	if (previous.kind === "missing") {
		return { reusable: true };
	}

	if (previous.kind !== "ok") {
		process.stderr.write(
			`Warning: Previous build manifest is unusable (${previous.kind}); rebuilding place.\n`,
		);
		return { reusable: false };
	}

	return { coveragePlace: previous.manifest.coveragePlace, reusable: true };
}

/**
 * Incremental no-change short-circuit: reuse the prior place only if it is still
 * on disk and its bytes match the prior build manifest's record. A missing or
 * drifted artifact (e.g. an interrupted prior build) returns `undefined` so the
 * caller does a full rebuild rather than publishing a manifest that points at a
 * stale or absent `.rbxl`.
 */
function reuseCoverageResult(options: ReuseCoverageOptions): PrepareCoverageResult | undefined {
	const { buildManifestPath, files, hasChanges, previousManifest } = options;
	if (hasChanges || previousManifest?.placeFilePath === undefined) {
		return undefined;
	}

	const { buildId, placeFilePath } = previousManifest;
	const reuse = priorPlaceIsReusable(placeFilePath, buildManifestPath);
	if (!reuse.reusable) {
		return undefined;
	}

	return {
		buildId,
		// Reuse the hash `readBuildManifest` already computed; only a
		// pre-BuildManifest cache (no recorded place) falls back to hashing.
		coveragePlace: reuse.coveragePlace ?? {
			hash: hashFile(placeFilePath),
			path: placeFilePath,
		},
		files,
		manifest: previousManifest,
		placeFile: placeFilePath,
		rebuilt: false,
	};
}
