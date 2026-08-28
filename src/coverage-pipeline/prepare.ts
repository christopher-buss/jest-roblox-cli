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
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type {
	BuildManifestArtifact,
	BuildManifestFileRecord,
	BuildManifestProject,
	CoverageArtifacts,
} from "./build-manifest.ts";
import { BUILD_MANIFEST_FILE, readBuildManifest, toBuildManifestFiles } from "./build-manifest.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { createCopyIgnoreMatcher, hashCopyIgnorePatterns } from "./discover-files.ts";
import { canReuseCoverageManifest } from "./incremental-gate.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import { createInstrumentUniverse } from "./instrument-universe.ts";
import { INSTRUMENTER_VERSION } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import { MANIFEST_VERSION, readManifest, writeManifest } from "./manifest.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowLuauRoots } from "./narrow-roots.ts";
import { tryComputeRojoInputsHash } from "./rojo-inputs.ts";
import { collectRojoMounts } from "./root-reachability.ts";
import type { ShadowRootResult } from "./shadow-root.ts";
import { prepareShadowRoot } from "./shadow-root.ts";
import type { ShadowLayout } from "./spine.ts";
import { createShadowLayout, prepareSpine } from "./spine.ts";

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
	/**
	 * Host time spent instrumenting into the shadow tree — the only part of
	 * this call a run reports as coverage.
	 */
	instrumentMs: number;
	manifest: CoverageManifest;
	placeFile: string;
	/**
	 * `true` when the place was rebuilt this run. `false` on the incremental
	 * no-change short-circuit, so an entry point can skip rewriting an
	 * identical Build Manifest.
	 */
	rebuilt: boolean;
	/**
	 * Host time spent on the part of this call a run reports as staging
	 * rather than as coverage: the `beforeBuild` stub bake, the reuse gate
	 * that decides whether the place has to be rebuilt, and the build itself.
	 * A non-coverage run pays the same work over uninstrumented sources, so
	 * charging it to coverage would put a coverage segment on a run that
	 * collected none.
	 */
	stagingMs: number;
}

export interface PrepareCoverageOptions {
	/** Hook run after the shadow tree is populated, before the place build. */
	beforeBuild?: ((layout: ShadowLayout) => boolean) | undefined;
	/**
	 * The run's effective coverage include globs, per `resolveCoverageInclude`
	 * — which is where the `collectCoverageFrom ?? derived` fallback lives. A
	 * caller that omits it gets the raw config value, so a run that never
	 * resolves the fallback still narrows by anything explicitly set.
	 */
	coverageInclude?: Array<string> | undefined;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	buildId: string;
	copyIgnoreHash: string;
	coverageUniverseHash: string | undefined;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
	rojoInputsHash: string;
}

interface PriorPlaceReuse {
	/**
	 * The prior manifest's validated coverage place, when a build manifest
	 * exists. `readBuildManifest` already re-hashed it, so the caller reuses
	 * this rather than hashing the same `.rbxl` a second time. Absent for
	 * pre-BuildManifest caches (coverage manifest only).
	 */
	coveragePlace?: BuildManifestArtifact | undefined;
	reusable: boolean;
}

/** One read of a rojo project: the tree, or why there is none. */
interface RojoProjectRead {
	/**
	 * The parse failure, held rather than thrown, and set only for a project
	 * too malformed to read — never for a missing one. A run that names its own
	 * `luauRoots` never needs the tree, and refusing it for a project it does
	 * not read would turn a working run into a hard failure, so only the root
	 * auto-detect rethrows this.
	 */
	failure: Error | undefined;
	/** Absent when the project is missing or too malformed to parse. */
	project: RojoProject | undefined;
}

/** The rojo project a run reads, parsed once and shared by everything. */
interface RojoContext extends RojoProjectRead {
	config: ResolvedConfig;
	/** What `$path` resolves against — the project's own directory. */
	rojoDirectory: string | undefined;
}

/** Everything resolved from config before any shadow dir is touched. */
interface CoverageInputs {
	buildManifestPath: string;
	/** Digest of the copy-ignore list, for the incremental gate. */
	copyIgnoreHash: string;
	/**
	 * `false` when the rojo inputs could not be hashed, which turns the
	 * inputs-drift check off rather than forcing a rebuild.
	 */
	hasResolvedInputs: boolean;
	/** The compiled `coverageCopyIgnorePatterns` gate for every root. */
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoots: Array<string>;
	manifestPath: string;
	/**
	 * Each rojo mount with the roots the universe narrowed it to. Carried
	 * whole because the spine mirror reads `coverageCopyIgnorePatterns` in the
	 * mount's own frame, which a flattened root list would have lost.
	 */
	narrowed: Array<NarrowedMount>;
	previousManifest: CoverageManifest | undefined;
	rojoInputsHash: string;
	rojoProjectPath: string;
	/** Absent when the config narrows nothing — the whole root is probed. */
	universe: InstrumentUniverse | undefined;
}

/** The merged instrumentation output across every luauRoot. */
interface ShadowRootsResult {
	changed: boolean;
	coverageRoots: Array<CoverageRoot>;
	/** The demoted levels, paired with the shadow copy that stands in. */
	coverageSpine: Array<CoverageRoot>;
	files: Record<string, InstrumentedFileRecord>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
}

/** What the coverage place build reads, once the shadow is populated. */
interface BuildCoveragePlaceOptions {
	packageDirectory: string;
	placeFile: string;
	rojoProjectPath: string;
	shadow: Pick<ShadowRootsResult, "coverageRoots" | "coverageSpine">;
}

interface RojoInputsHashResult {
	hash: string;
	resolved: boolean;
}

/** A prior place this run can reuse: everything but the phase timings. */
type ReusedCoverage = Pick<
	PrepareCoverageResult,
	"buildId" | "coveragePlace" | "files" | "manifest" | "placeFile" | "rebuilt"
>;

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
		// An absolute mount cannot be a luauRoot: a root names where the shadow
		// mirrors a tree under `rootDir`, and `validateRelativeRoots` rejects
		// anything else. Rojo still builds the mount; it just reports no
		// coverage. Workspace mode asks the wider question in
		// `discoverFromRojoWalk` — does the mount land inside the package —
		// which also keeps an absolute mount that does; the two answers differ
		// until this one resolves against `rootDir` rather than the cwd.
		if (isAbsolutePath(directoryPath)) {
			return false;
		}

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
	return resolveLuauRootsWithRojo(readRojoContext(config, tryFindRojoProject(config)));
}

export function prepareCoverage(
	config: ResolvedConfig,
	{ beforeBuild, coverageInclude }: PrepareCoverageOptions = {},
): PrepareCoverageResult {
	const instrumentStart = Date.now();
	const inputs = resolveCoverageInputs(config, coverageInclude);
	const isIncremental = decideIncremental(config, inputs);

	const shadow = prepareShadowRoots(inputs, isIncremental);
	// Coverage pays for the instrumentation and nothing else. Everything below
	// is the place build and the gate deciding whether to do it — `beforeBuild`
	// bakes stubs into the shadow tree, and the reuse gate re-hashes the cached
	// place. Both are staging: a non-coverage run pays the same work.
	const instrumentMs = Date.now() - instrumentStart;

	const stagingStart = Date.now();
	const hasChanges = hasCoverageChanges(inputs, {
		hasExtraChanges: beforeBuild?.(createShadowLayout(COVERAGE_DIR, inputs.narrowed)) === true,
		isIncremental,
		shadow,
	});
	const placeFile = path.join(COVERAGE_DIR, "game.rbxl");
	const files = toBuildManifestFiles(shadow.files);
	const reused = reuseCoverageResult(inputs, files, hasChanges);
	if (reused !== undefined) {
		return toReusedResult(reused, instrumentMs, Date.now() - stagingStart);
	}

	const built = buildCoveragePlaceAndManifest(config, inputs, shadow, placeFile);

	return {
		buildId: built.buildId,
		coveragePlace: built.coveragePlace,
		files,
		instrumentMs,
		manifest: built.manifest,
		placeFile,
		rebuilt: true,
		stagingMs: Date.now() - stagingStart,
	};
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

/** {@link findRojoProject}, answering `undefined` where there is no project. */
function tryFindRojoProject(config: ResolvedConfig): string | undefined {
	try {
		return findRojoProject(config);
	} catch {
		return undefined;
	}
}

/**
 * Auto-detect coverage roots from the Rojo project's `$path` mounts. Returns
 * `undefined` when no project file was found or it mounted nothing
 * instrumentable, so the caller falls through to the tsconfig `outDir`.
 */
function detectRootsFromRojo(
	config: ResolvedConfig,
	resolved: RojoProject | undefined,
): Array<string> | undefined {
	if (resolved === undefined) {
		return undefined;
	}

	const roots = collectLuauRootsFromRojo(resolved, config);
	return roots.length > 0 ? roots : undefined;
}

function resolveLuauRootsWithRojo({ config, failure, project }: RojoContext): Array<string> {
	if (config.luauRoots !== undefined && config.luauRoots.length > 0) {
		return config.luauRoots;
	}

	if (failure !== undefined) {
		throw failure;
	}

	const rojoRoots = detectRootsFromRojo(config, project);
	if (rojoRoots !== undefined) {
		return rojoRoots;
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

/**
 * The project with its nested `.project.json` mounts inlined, or `undefined`
 * when there is none to read. Both the root auto-detect and the mount set the
 * demote is judged against come from this one read.
 */
function loadResolvedRojoProject(resolvedPath: string): RojoProjectRead {
	try {
		const validated = rojoProjectSchema(JSON.parse(fs.readFileSync(resolvedPath, "utf-8")));
		if (validated instanceof type.errors) {
			throw new Error(validated.summary);
		}

		return {
			failure: undefined,
			project: {
				...validated,
				tree: resolveNestedProjects(validated.tree, path.dirname(resolvedPath)),
			},
		};
	} catch (err) {
		// Expected: nothing readable there → the caller falls through to the
		// tsconfig outDir. Unexpected: malformed JSON → held for the caller
		// that depends on the tree, to help debugging.
		return {
			failure:
				err instanceof SyntaxError
					? new Error(`Malformed Rojo project JSON: ${err.message}`, { cause: err })
					: undefined,
			project: undefined,
		};
	}
}

/** {@link loadResolvedRojoProject}, with the parse failure held for later. */
function readRojoContext(config: ResolvedConfig, rojoProjectPath: string | undefined): RojoContext {
	if (rojoProjectPath === undefined) {
		// No project file at all: the caller falls through to tsconfig's outDir,
		// and there are no mounts to judge a demote against.
		return { config, failure: undefined, project: undefined, rojoDirectory: undefined };
	}

	const projectPath = rojoProjectPath;

	return {
		...loadResolvedRojoProject(projectPath),
		config,
		rojoDirectory: path.dirname(projectPath),
	};
}

// Announce the reuse and hand the prior place back. Nothing was built, but the
// gate that decided so re-hashed the cached place, so staging still carries
// what the decision cost.
function toReusedResult(
	reused: ReusedCoverage,
	instrumentMs: number,
	stagingMs: number,
): PrepareCoverageResult {
	process.stderr.write(`Reusing cached coverage place (built ${reused.manifest.generatedAt})\n`);
	return { ...reused, instrumentMs, stagingMs };
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

/**
 * Hash the rojo build inputs the per-luauRoot shadow diff never sees
 * (include/, vendored @rbxts, assets, the project files). Runs regardless of
 * how luauRoots resolved. A malformed/circular project throws; degrade to
 * `resolved: false` so the caller skips the inputs check (a project too broken
 * to hash would also fail the rebuild's own parse) rather than hard-failing a
 * working run.
 */
function resolveRojoInputsHash(
	config: ResolvedConfig,
	rojoProjectPath: string,
	luauRoots: Array<string>,
): RojoInputsHashResult {
	const hash = tryComputeRojoInputsHash({
		luauRoots,
		rojoProjectPath,
		rootDirectory: config.rootDir,
	});
	return hash === undefined ? { hash: "", resolved: false } : { hash, resolved: true };
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

/**
 * The run's instrument-time universe.
 *
 * No `rootDir`: the candidate paths these globs are matched against are
 * cwd-relative here. `luauRoots` are walked from the invocation directory and
 * `COVERAGE_DIR` hangs off it, so the manifest keys — and through them the
 * mapped TS paths — are cwd-relative too. Anchoring the globs anywhere else
 * would match none of them. Only workspace mode, whose candidates are absolute
 * under a package, has an anchor worth preferring.
 */
function resolveUniverse(
	config: ResolvedConfig,
	coverageInclude: Array<string> | undefined,
): InstrumentUniverse | undefined {
	return createInstrumentUniverse({
		ignore: config.coveragePathIgnorePatterns,
		include: coverageInclude ?? config.collectCoverageFrom,
	});
}

/**
 * The project's `$path` mounts, in the frame `luauRoots` are written in.
 *
 * Only a mount is a directory the demote can rewrite, and a `luauRoot` need
 * not be one — `places/main` names `out` while the project mounts
 * `out/client` and `out/server`.
 *
 * Relativized against `rootDir` because that is what synthesis resolves a
 * coverage root against, so a mount and a root agree here exactly when they
 * agree there.
 */
function resolveRojoMounts({ config, project, rojoDirectory }: RojoContext): ReadonlySet<string> {
	if (project === undefined || rojoDirectory === undefined) {
		return new Set();
	}

	const mounts = collectRojoMounts(project.tree, rojoDirectory);
	return new Set(
		Array.from(mounts, (mount) => normalizeWindowsPath(path.relative(config.rootDir, mount))),
	);
}

/**
 * Resolve the rojo project, the luau roots, the non-luauRoot inputs hash and
 * the prior manifest — everything the rest of the run reads but never mutates.
 */
function resolveCoverageInputs(
	config: ResolvedConfig,
	coverageInclude: Array<string> | undefined,
): CoverageInputs {
	const rojoProjectPath = findRojoProject(config);
	// One read: the root auto-detect and the mount set the demote is judged
	// against both come from the same tree, nested projects included.
	const rojo = readRojoContext(config, rojoProjectPath);
	const mounts = resolveLuauRootsWithRojo(rojo);

	validateRelativeRoots(mounts);

	const isCopyIgnored = createCopyIgnoreMatcher(config.coverageCopyIgnorePatterns);
	const universe = resolveUniverse(config, coverageInclude);
	// Narrowed before anything is instrumented: the universe resolves off
	// directory entries and source maps alone, so what comes back is what the
	// shadow has to mirror rather than every file the mount holds.
	const narrowed = narrowLuauRoots(mounts, {
		isCopyIgnored,
		rojoMounts: resolveRojoMounts(rojo),
		universe,
	});
	const luauRoots = narrowed.flatMap((entry) => entry.roots);
	const inputs = resolveRojoInputsHash(config, rojoProjectPath, luauRoots);
	const manifestPath = path.join(COVERAGE_DIR, COVERAGE_MANIFEST);

	return {
		buildManifestPath: path.join(COVERAGE_DIR, BUILD_MANIFEST_FILE),
		copyIgnoreHash: hashCopyIgnorePatterns(config.coverageCopyIgnorePatterns),
		hasResolvedInputs: inputs.resolved,
		isCopyIgnored,
		luauRoots,
		manifestPath,
		narrowed,
		previousManifest: loadCoverageManifest(manifestPath),
		rojoInputsHash: inputs.hash,
		rojoProjectPath,
		universe,
	};
}

function hasDroppedLuauRoot(previous: Array<string>, current: Array<string>): boolean {
	const currentSet = new Set(current.map(normalizeWindowsPath));
	return previous.some((root) => !currentSet.has(normalizeWindowsPath(root)));
}

/**
 * Decide whether the cached shadow dirs can be reused, wiping the coverage dir
 * when they can't so a cold run starts from nothing.
 */
function decideIncremental(
	config: ResolvedConfig,
	{ copyIgnoreHash, luauRoots, previousManifest, universe }: CoverageInputs,
): boolean {
	let isIncremental = canReuseCoverageManifest(previousManifest, {
		copyIgnoreHash,
		coverageCache: config.coverageCache,
		universe,
	});

	// A dropped luauRoot is invisible to the per-root reconcile — it only walks
	// the current roots — so the dropped root's instrumented shadow subtree and
	// its stale manifest entries would survive a reuse. Force a cold rebuild so
	// the rmSync below wipes them. An *added* root needs no cold rebuild: the
	// existing roots stay cached and the new one is instrumented normally.
	if (
		isIncremental &&
		previousManifest !== undefined &&
		hasDroppedLuauRoot(previousManifest.luauRoots, luauRoots)
	) {
		isIncremental = false;
	}

	if (!isIncremental && fs.existsSync(COVERAGE_DIR)) {
		fs.rmSync(COVERAGE_DIR, { recursive: true });
	}

	return isIncremental;
}

/**
 * One narrowed root, instrumented into the shadow directory that mirrors it.
 */
function instrumentOneRoot(
	{ isCopyIgnored, previousManifest, universe }: CoverageInputs,
	{ isIncremental, luauRoot }: { isIncremental: boolean; luauRoot: string },
): ShadowRootResult {
	return prepareShadowRoot({
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir: normalizeWindowsPath(path.join(COVERAGE_DIR, luauRoot)),
		universe,
		useIncremental: isIncremental,
	});
}

/** Instrument every luauRoot into its shadow dir and merge the results. */
function prepareShadowRoots(inputs: CoverageInputs, isIncremental: boolean): ShadowRootsResult {
	const files: Record<string, InstrumentedFileRecord> = {};
	const coverageRoots: Array<CoverageRoot> = [];
	// Paths here are already the source's own — this mode walks them from the
	// invocation directory — so a spine level names its own directory.
	const spine = prepareSpine({
		isCopyIgnored: inputs.isCopyIgnored,
		narrowed: inputs.narrowed,
		previousNonInstrumented: inputs.previousManifest?.nonInstrumentedFiles,
		shadowRoot: COVERAGE_DIR,
		toSourcePath: (relativePath) => relativePath,
	});
	const nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord> = { ...spine.files };
	let hasChanges = spine.changed;

	for (const luauRoot of inputs.luauRoots) {
		const result = instrumentOneRoot(inputs, { isIncremental, luauRoot });
		hasChanges ||= result.changed;
		Object.assign(files, result.files);
		Object.assign(nonInstrumentedFiles, result.nonInstrumentedFiles);
		coverageRoots.push({
			luauRoot: result.luauRoot,
			shadowDir: normalizeWindowsPath(path.resolve(result.shadowDir)),
		});
	}

	return {
		changed: hasChanges,
		coverageRoots,
		coverageSpine: spine.directories,
		files,
		nonInstrumentedFiles,
	};
}

/**
 * A non-luauRoot rojo input changed — the shadow diff can't see those, so force
 * a rebuild rather than reuse a stale place built from the old include/ or
 * vendored sources. When the inputs couldn't be hashed the check is skipped
 * (not forced): a project too broken to hash would also fail the rebuild's own
 * parse, so preserve the prior reuse behavior instead of converting it into a
 * hard failure.
 */
function hasRojoInputDrift(
	{ hasResolvedInputs, previousManifest, rojoInputsHash }: CoverageInputs,
	isIncremental: boolean,
): boolean {
	return (
		isIncremental && hasResolvedInputs && previousManifest?.rojoInputsHash !== rojoInputsHash
	);
}

// Rebuild unless every input is unchanged: a non-incremental run always
// rebuilds, and so does any drift in the shadow tree, the caller's bake hook, or
// a rojo input.
function hasCoverageChanges(
	inputs: CoverageInputs,
	{
		hasExtraChanges,
		isIncremental,
		shadow,
	}: { hasExtraChanges: boolean; isIncremental: boolean; shadow: ShadowRootsResult },
): boolean {
	return (
		!isIncremental ||
		shadow.changed ||
		hasExtraChanges ||
		hasRojoInputDrift(inputs, isIncremental)
	);
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
 * Incremental no-change short-circuit: reuse the prior place only if it is
 * still on disk and its bytes match the prior build manifest's record. A
 * missing or drifted artifact (e.g. an interrupted prior build) returns
 * `undefined` so the caller does a full rebuild rather than publishing a
 * manifest that points at a stale or absent `.rbxl`.
 */
function reuseCoverageResult(
	{ buildManifestPath, previousManifest }: CoverageInputs,
	files: Record<string, BuildManifestFileRecord>,
	hasChanges: boolean,
): ReusedCoverage | undefined {
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

function buildRojoProject({
	packageDirectory,
	placeFile,
	rojoProjectPath,
	shadow,
}: BuildCoveragePlaceOptions): BuildManifestArtifact {
	return buildPlace({
		// The coverage place is shared by every backend. studio-cli opens it
		// directly and drives the plugin's Run-mode runner, which refuses to run
		// unless LoadString is enabled; enabling it here is benign for the
		// open-cloud path (OCALE does not gate on it). Forcing it on at build
		// time keeps "studio-cli only selects the coverage place" true.
		loadStringEnabled: true,
		packages: [
			{
				name: "jest-roblox-coverage",
				coverageRoots: shadow.coverageRoots,
				coverageSpine: shadow.coverageSpine,
				packageDirectory: path.resolve(packageDirectory),
				rojoProjectPath: path.resolve(rojoProjectPath),
			},
		],
		placeFile,
		projectFile: path.join(COVERAGE_DIR, path.basename(rojoProjectPath)),
		wrap: false,
	});
}

function buildAndWriteManifest({
	allFiles,
	buildId,
	copyIgnoreHash,
	coverageUniverseHash,
	luauRoots,
	manifestPath,
	nonInstrumentedFiles,
	placeFile,
	rojoInputsHash,
}: WriteManifestOptions): CoverageManifest {
	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId,
		copyIgnoreHash,
		coverageUniverseHash,
		files: allFiles,
		generatedAt: generatedAtDate.toISOString(),
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

/**
 * Build the `.rbxl` first, then write the manifest. The order matters: a failed
 * `buildRojoProject` throws before the coverage manifest is written, so an
 * interrupted run never leaves a manifest claiming an artifact that isn't on
 * disk. The caller owns Build Manifest emission (it alone knows the full place
 * set), keeping that write a single atomic operation.
 */
function buildCoveragePlaceAndManifest(
	config: ResolvedConfig,
	inputs: CoverageInputs,
	shadow: ShadowRootsResult,
	placeFile: string,
): Pick<PrepareCoverageResult, "buildId" | "coveragePlace" | "manifest"> {
	const coveragePlace = buildRojoProject({
		packageDirectory: config.rootDir,
		placeFile,
		rojoProjectPath: inputs.rojoProjectPath,
		shadow,
	});

	const buildId = crypto.randomUUID();
	const manifest = buildAndWriteManifest({
		allFiles: shadow.files,
		buildId,
		copyIgnoreHash: inputs.copyIgnoreHash,
		coverageUniverseHash: inputs.universe?.digest,
		luauRoots: inputs.luauRoots,
		manifestPath: inputs.manifestPath,
		nonInstrumentedFiles: shadow.nonInstrumentedFiles,
		placeFile,
		rojoInputsHash: inputs.rojoInputsHash,
	});

	return { buildId, coveragePlace, manifest };
}
