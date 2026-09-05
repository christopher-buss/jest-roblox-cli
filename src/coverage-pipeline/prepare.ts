import { collectPaths, resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as crypto from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../executor/tsconfig-mappings.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { CoverageRoot } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { NOOP_TIMING_COLLECTOR } from "../timing/orchestration-collector.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashFileAsync } from "../utils/hash.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	isAbsolutePath,
	normalizeWindowsPath,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
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
import { tryComputeRojoInputsHashAsync } from "./rojo-inputs.ts";
import { collectRojoMounts, resolveMountWithin } from "./root-reachability.ts";
import type { BakeOwnershipMatcher, ShadowRootResult } from "./shadow-root.ts";
import { prepareShadowRoot } from "./shadow-root.ts";
import type { PreparedSpine, ShadowBake } from "./spine.ts";
import { createShadowLayout, prepareSpine } from "./spine.ts";

const COVERAGE_DIR = ".jest-roblox/coverage";
/** Framed on `rootDir`, and outside the directory a cold rebuild wipes. */
const INPUT_DIGEST_PATH = ".jest-roblox/input-digests";
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
	 * rather than as coverage: the run's stub bake, the reuse gate
	 * that decides whether the place has to be rebuilt, and the build itself.
	 * A non-coverage run pays the same work over uninstrumented sources, so
	 * charging it to coverage would put a coverage segment on a run that
	 * collected none.
	 */
	stagingMs: number;
}

export interface PrepareCoverageOptions {
	/** What this run writes into the shadow before the place is built. */
	bake?: ShadowBake | undefined;
	/**
	 * The run's effective coverage include globs, per `resolveCoverageInclude`
	 * — which is where the `collectCoverageFrom ?? derived` fallback lives. A
	 * caller that omits it gets the raw config value, so a run that never
	 * resolves the fallback still narrows by anything explicitly set.
	 */
	coverageInclude?: Array<string> | undefined;
	/** Where the shadow is built. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * The run's collector, so the two phases this call reports nest under the
	 * `prepareCoverage` span the caller opened around it. Omitted by the
	 * offline build path, which has no run to profile; both phases are still
	 * measured, since their durations feed a Duration line either way.
	 */
	timing?: TimingCollector | undefined;
	/** How a tsconfig is read. Defaults to the real one. */
	tsconfigReader?: TsconfigReader | undefined;
}

/** A rojo project this run could read, with the frame its mounts are in. */
export interface RojoProjectInFrame {
	project: RojoProject;
	/** What `$path` resolves against — the project's own directory. */
	rojoDirectory: string;
}

interface WriteManifestOptions {
	allFiles: Record<string, InstrumentedFileRecord>;
	buildId: string;
	copyIgnoreHash: string;
	coverageUniverseHash: string | undefined;
	fileSystem: FileSystem;
	luauRoots: Array<string>;
	manifestPath: string;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFile: string;
	rojoInputsHash: string;
}

/** The two settings every shadow pass of one run reads the same way. */
interface ShadowPassSettings {
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isIncremental: boolean;
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
	/**
	 * Absent when the project is missing or too malformed to parse. The tree
	 * and the directory it is read against travel as one: a mount means
	 * nothing without the frame it resolves in.
	 */
	loaded: RojoProjectInFrame | undefined;
}

/** The rojo project a run reads, parsed once and shared by everything. */
interface RojoContext extends RojoProjectRead {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	tsconfigReader: TsconfigReader;
}

/** Everything resolved from config before any shadow dir is touched. */
interface CoverageInputs {
	buildManifestPath: string;
	/** Digest of the copy-ignore list, for the incremental gate. */
	copyIgnoreHash: string;
	fileSystem: FileSystem;
	/**
	 * `false` when the rojo inputs could not be hashed, which turns the
	 * inputs-drift check off rather than forcing a rebuild.
	 */
	hasResolvedInputs: boolean;
	/** The compiled `coverageCopyIgnorePatterns` gate for every root. */
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoots: Array<PosixRoot>;
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
	fileSystem: FileSystem;
	packageDirectory: string;
	placeFile: string;
	rojoProjectPath: string;
	shadow: Pick<ShadowRootsResult, "coverageRoots" | "coverageSpine">;
}

interface RojoInputsHashResult {
	hash: string;
	resolved: boolean;
}

/**
 * The place the bake settled on, reused or built: the result minus the two
 * phase timings, which only the caller that spanned them can supply.
 */
type BakedCoveragePlace = Pick<
	PrepareCoverageResult,
	"buildId" | "coveragePlace" | "files" | "manifest" | "placeFile" | "rebuilt"
>;

/** What the instrumentation phase leaves behind for the place build. */
interface InstrumentedCoverage {
	inputs: CoverageInputs;
	isIncremental: boolean;
	shadow: ShadowRootsResult;
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

/**
 * The project's `$path` mounts that this run can take as coverage roots,
 * `rootDir`-relative.
 *
 * `rootDir` is the frame — `MountFrame` says why the modes share one, and here
 * it is where a root is read from by everything downstream: synthesis resolves
 * one against it, the rojo inputs hash joins one onto it, and
 * `resolveRojoMounts` states the mounts in it. A root probed in any other
 * frame, the cwd included, is one the rest of the run cannot find.
 */
export function collectLuauRootsFromRojo(
	{ project, rojoDirectory }: RojoProjectInFrame,
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
): Array<string> {
	const paths: Array<string> = [];
	collectPaths(project.tree, paths);

	const ignorePatterns = config.coveragePathIgnorePatterns;
	// contains: true so bare strings like "rojo-sync" match "rojo-sync/rbxts",
	// mirroring Jest's regex-based coveragePathIgnorePatterns behavior.
	const isIgnored = picomatch(ignorePatterns, { contains: true });

	const seen = new Set<string>();
	const roots: Array<string> = [];
	for (const rawPath of paths) {
		const root = resolveMountWithin(rawPath, { frame: config.rootDir, rojoDirectory });
		// One `$path` mounted at two places in the tree is one root: taken
		// twice it is instrumented into the same shadow dir twice and named
		// twice in the manifest. Workspace mode dedupes in
		// `discoverFromRojoWalk` for the same reason.
		if (root === undefined || seen.has(root) || isIgnored(root)) {
			continue;
		}

		const directoryPath = path.resolve(config.rootDir, root);
		if (!fileSystem.existsSync(directoryPath)) {
			continue;
		}

		// Only directories can be coverage roots (skip single-file $path entries)
		if (!fileSystem.statSync(directoryPath).isDirectory()) {
			continue;
		}

		if (containsLuauFiles(fileSystem, directoryPath)) {
			seen.add(root);
			roots.push(root);
		}
	}

	return roots;
}

export function findRojoProject(
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
): string {
	if (config.rojoProject !== undefined) {
		return config.rojoProject;
	}

	const defaultPath = path.join(config.rootDir, "default.project.json");
	if (fileSystem.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fileSystem.readdirSync(config.rootDir, "utf-8");
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	if (projectFile !== undefined) {
		return path.join(config.rootDir, projectFile);
	}

	throw new Error(
		"No Rojo project found. Set rojoProject in config or add a .project.json file.",
	);
}

export function resolveLuauRoots(
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
	tsconfigReader: TsconfigReader = nodeTsconfigReader,
): Array<PosixRoot> {
	return resolveLuauRootsWithRojo(
		readRojoContext(config, tryFindRojoProject(config, fileSystem), fileSystem, tsconfigReader),
	);
}

export async function prepareCoverageAsync(
	config: ResolvedConfig,
	{
		bake,
		coverageInclude,
		fileSystem = nodeFileSystem,
		timing = NOOP_TIMING_COLLECTOR,
		tsconfigReader = nodeTsconfigReader,
	}: PrepareCoverageOptions = {},
): Promise<PrepareCoverageResult> {
	const { elapsedMs: instrumentMs, value: instrumented } = await timing.profileTimedAsync(
		"instrumentSources",
		async () => {
			const inputs = await resolveCoverageInputsAsync(
				config,
				coverageInclude,
				fileSystem,
				tsconfigReader,
			);
			const isIncremental = decideIncremental(config, inputs);
			const pass = { isBakeOwned: bake?.isBakeOwned, isIncremental };
			return { inputs, isIncremental, shadow: prepareShadowRoots(inputs, pass) };
		},
	);

	// Coverage pays for the instrumentation and nothing else. The other phase is
	// the place build and the gate deciding whether to do it — the bake writes
	// stubs into the shadow tree, and the reuse gate re-hashes the cached
	// place. Both are staging: a non-coverage run pays the same work.
	const { elapsedMs: stagingMs, value: baked } = await timing.profileTimedAsync(
		"bakeCoveragePlace",
		async () => bakeCoveragePlaceAsync({ bake, config, instrumented }),
	);

	return { ...baked, instrumentMs, stagingMs };
}

function containsLuauFiles(fileSystem: FileSystem, directoryPath: string): boolean {
	const entries = fileSystem.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && entry.name.endsWith(".luau")) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(fileSystem, path.join(directoryPath, entry.name));
		}

		return false;
	});
}

/** {@link findRojoProject}, answering `undefined` where there is no project. */
function tryFindRojoProject(config: ResolvedConfig, fileSystem: FileSystem): string | undefined {
	try {
		return findRojoProject(config, fileSystem);
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
	loaded: RojoProjectInFrame | undefined,
	config: ResolvedConfig,
	fileSystem: FileSystem,
): Array<string> | undefined {
	if (loaded === undefined) {
		return undefined;
	}

	const roots = collectLuauRootsFromRojo(loaded, config, fileSystem);
	return roots.length > 0 ? roots : undefined;
}

/**
 * Gets the luau roots from the first source that supplies them: the config
 * `luauRoots`, the rojo mounts, then the tsconfig `outDir`. Each root keeps
 * the spelling of its source. Use {@link resolveLuauRootsWithRojo} to get
 * corrected roots.
 */
function selectRawLuauRoots({
	config,
	failure,
	fileSystem,
	loaded,
	tsconfigReader,
}: RojoContext): Array<string> {
	if (config.luauRoots !== undefined && config.luauRoots.length > 0) {
		return config.luauRoots;
	}

	if (failure !== undefined) {
		throw failure;
	}

	const rojoRoots = detectRootsFromRojo(loaded, config, fileSystem);
	if (rojoRoots !== undefined) {
		return rojoRoots;
	}

	const tsconfig = tsconfigReader(config.rootDir) ?? undefined;
	const outDirectory = tsconfig?.config.compilerOptions?.outDir;
	if (outDirectory !== undefined) {
		return [outDirectory];
	}

	throw new Error(
		"Could not determine luauRoots. Set luauRoots in config or ensure tsconfig has outDir.",
	);
}

/**
 * Gets the luau roots for this run and corrects the spelling of each one. A
 * user writes the config `luauRoots` and the tsconfig `outDir` by hand, thus
 * their spelling can differ from the spelling the pipeline needs. The
 * correction is here, and not in each source, so that a new source also gets
 * it.
 *
 * Correcting the spelling is what makes the dedupe possible, and the dedupe is
 * what the correction is for: two spellings of one directory reduce to one
 * string, and the second is dropped rather than instrumented and mirrored into
 * a shadow the first already holds. Workspace mode does the same in
 * `discoverFromLuauRoots`.
 */
function resolveLuauRootsWithRojo(context: RojoContext): Array<PosixRoot> {
	return [...new Set(selectRawLuauRoots(context).map(toPosixRoot))];
}

/**
 * The project with its nested `.project.json` mounts inlined, or `undefined`
 * when there is none to read. Both the root auto-detect and the mount set the
 * demote is judged against come from this one read.
 */
function loadResolvedRojoProject(fileSystem: FileSystem, resolvedPath: string): RojoProjectRead {
	try {
		const validated = rojoProjectSchema(
			JSON.parse(fileSystem.readFileSync(resolvedPath, "utf-8")),
		);
		if (validated instanceof type.errors) {
			throw new Error(validated.summary);
		}

		const rojoDirectory = path.dirname(resolvedPath);

		return {
			failure: undefined,
			loaded: {
				project: {
					...validated,
					tree: resolveNestedProjects(validated.tree, rojoDirectory, fileSystem),
				},
				rojoDirectory,
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
			loaded: undefined,
		};
	}
}

/** {@link loadResolvedRojoProject}, with the parse failure held for later. */
function readRojoContext(
	config: ResolvedConfig,
	rojoProjectPath: string | undefined,
	fileSystem: FileSystem,
	tsconfigReader: TsconfigReader,
): RojoContext {
	if (rojoProjectPath === undefined) {
		// No project file at all: the caller falls through to tsconfig's outDir,
		// and there are no mounts to judge a demote against.
		return { config, failure: undefined, fileSystem, loaded: undefined, tsconfigReader };
	}

	return {
		...loadResolvedRojoProject(fileSystem, rojoProjectPath),
		config,
		fileSystem,
		tsconfigReader,
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

function priorPlaceIsReusable(
	fileSystem: FileSystem,
	placeFilePath: string,
	buildManifestPath: string,
): PriorPlaceReuse {
	if (!fileSystem.existsSync(placeFilePath)) {
		return { reusable: false };
	}

	// A prior build manifest validates the cached artifacts: `readBuildManifest`
	// re-hashes the coverage place (and sources), so any drift or corruption
	// yields a non-ok result and forces a rebuild. Pre-BuildManifest caches
	// (coverage manifest only) have no build manifest yet, so the existence check
	// above is the only gate — keeping the no-change path working across
	// upgrades.
	const previous = readBuildManifest(buildManifestPath, { fileSystem });
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
async function reuseCoverageResultAsync(
	{ buildManifestPath, fileSystem, previousManifest }: CoverageInputs,
	files: Record<string, BuildManifestFileRecord>,
	hasChanges: boolean,
): Promise<BakedCoveragePlace | undefined> {
	if (hasChanges || previousManifest?.placeFilePath === undefined) {
		return undefined;
	}

	const { buildId, placeFilePath } = previousManifest;
	const reuse = priorPlaceIsReusable(fileSystem, placeFilePath, buildManifestPath);
	if (!reuse.reusable) {
		return undefined;
	}

	return {
		buildId,
		// Reuse the hash `readBuildManifest` already computed; only a
		// pre-BuildManifest cache (no recorded place) falls back to hashing.
		coveragePlace: reuse.coveragePlace ?? {
			hash: await hashFileAsync(placeFilePath, fileSystem),
			path: placeFilePath,
		},
		files,
		manifest: previousManifest,
		placeFile: placeFilePath,
		rebuilt: false,
	};
}

async function buildRojoProjectAsync({
	fileSystem,
	packageDirectory,
	placeFile,
	rojoProjectPath,
	shadow,
}: BuildCoveragePlaceOptions): Promise<BuildManifestArtifact> {
	return buildPlaceAsync({
		fileSystem,
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
	fileSystem,
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

	writeManifest(manifestPath, manifest, fileSystem);

	return manifest;
}

/**
 * Build the `.rbxl` first, then write the manifest. The order matters: a failed
 * `buildRojoProject` throws before the coverage manifest is written, so an
 * interrupted run never leaves a manifest claiming an artifact that isn't on
 * disk. The caller owns Build Manifest emission (it alone knows the full place
 * set), keeping that write a single atomic operation.
 */
async function buildPlaceAndManifestAsync(
	config: ResolvedConfig,
	inputs: CoverageInputs,
	shadow: ShadowRootsResult,
	placeFile: string,
): Promise<Pick<PrepareCoverageResult, "buildId" | "coveragePlace" | "manifest">> {
	const coveragePlace = await buildRojoProjectAsync({
		fileSystem: inputs.fileSystem,
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
		fileSystem: inputs.fileSystem,
		luauRoots: inputs.luauRoots,
		manifestPath: inputs.manifestPath,
		nonInstrumentedFiles: shadow.nonInstrumentedFiles,
		placeFile,
		rojoInputsHash: inputs.rojoInputsHash,
	});

	return { buildId, coveragePlace, manifest };
}

/**
 * Bake the run's stubs into the instrumented tree, decide whether the cached
 * place still answers for it, and build one when it does not. Everything a
 * non-coverage run would pay for over uninstrumented sources, which is why the
 * caller reports it as staging rather than as coverage.
 */
async function bakeCoveragePlaceAsync({
	bake,
	config,
	instrumented: { inputs, isIncremental, shadow },
}: {
	bake: PrepareCoverageOptions["bake"];
	config: ResolvedConfig;
	instrumented: InstrumentedCoverage;
}): Promise<BakedCoveragePlace> {
	// The layout stays inside the optional call: a run with no bake never
	// builds one, and it is the only thing that would read it.
	const hasExtraChanges = bake?.run(createShadowLayout(COVERAGE_DIR, inputs.narrowed)) === true;
	const hasChanges = hasCoverageChanges(inputs, { hasExtraChanges, isIncremental, shadow });
	const placeFile = path.join(COVERAGE_DIR, "game.rbxl");
	const files = toBuildManifestFiles(shadow.files);
	const reused = await reuseCoverageResultAsync(inputs, files, hasChanges);
	if (reused !== undefined) {
		// Nothing was built, but the gate that decided so re-hashed the cached
		// place, so this phase still carries what the decision cost.
		process.stderr.write(
			`Reusing cached coverage place (built ${reused.manifest.generatedAt})\n`,
		);
		return reused;
	}

	const built = await buildPlaceAndManifestAsync(config, inputs, shadow, placeFile);
	return {
		buildId: built.buildId,
		coveragePlace: built.coveragePlace,
		files,
		manifest: built.manifest,
		placeFile,
		rebuilt: true,
	};
}

/**
 * Hash the rojo build inputs the per-luauRoot shadow diff never sees
 * (include/, vendored @rbxts, assets, the project files). Runs regardless of
 * how luauRoots resolved. A malformed/circular project throws; degrade to
 * `resolved: false` so the caller skips the inputs check (a project too broken
 * to hash would also fail the rebuild's own parse) rather than hard-failing a
 * working run.
 */
async function resolveRojoInputsHashAsync(
	config: ResolvedConfig,
	rojoProjectPath: string,
	luauRoots: Array<string>,
	fileSystem: FileSystem,
): Promise<RojoInputsHashResult> {
	const hash = await tryComputeRojoInputsHashAsync({
		digestCacheFile: path.join(config.rootDir, INPUT_DIGEST_PATH),
		fileSystem,
		luauRoots,
		rojoProjectPath,
		rootDirectory: config.rootDir,
	});
	return hash === undefined ? { hash: "", resolved: false } : { hash, resolved: true };
}

function loadCoverageManifest(
	fileSystem: FileSystem,
	manifestPath: string,
): CoverageManifest | undefined {
	const result = readManifest(manifestPath, fileSystem);
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
	fileSystem: FileSystem,
): InstrumentUniverse | undefined {
	return createInstrumentUniverse(
		{
			ignore: config.coveragePathIgnorePatterns,
			include: coverageInclude ?? config.collectCoverageFrom,
		},
		fileSystem,
	);
}

/**
 * `isAbsolutePath`, not `path.isAbsolute`: the latter answers for the host it
 * runs on, so `D:/repo/out` is an absolute root a developer's machine rejects
 * and a plain relative filename Linux CI accepts and instruments outside the
 * package. The roots arrive canonical, so the drive letter reads the same way
 * on both.
 */
function validateRelativeRoots(luauRoots: ReadonlyArray<PosixRoot>): void {
	for (const root of luauRoots) {
		if (isAbsolutePath(root)) {
			throw new Error(
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		}
	}
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
function resolveRojoMounts({ config, loaded }: RojoContext): ReadonlySet<string> {
	if (loaded === undefined) {
		return new Set();
	}

	const mounts = collectRojoMounts(loaded.project.tree, loaded.rojoDirectory);
	return new Set(
		Array.from(mounts, (mount) => normalizeWindowsPath(path.relative(config.rootDir, mount))),
	);
}

/**
 * The luau roots this run instruments: the configured or auto-detected ones,
 * narrowed to the directories the coverage universe actually reaches.
 */
function narrowConfiguredRoots({
	config,
	fileSystem,
	isCopyIgnored,
	rojoProjectPath,
	tsconfigReader,
	universe,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	rojoProjectPath: string | undefined;
	tsconfigReader: TsconfigReader;
	universe: ReturnType<typeof resolveUniverse>;
}): ReturnType<typeof narrowLuauRoots> {
	// One read: the root auto-detect and the mount set the demote is judged
	// against both come from the same tree, nested projects included.
	const rojo = readRojoContext(config, rojoProjectPath, fileSystem, tsconfigReader);
	const mounts = resolveLuauRootsWithRojo(rojo);

	validateRelativeRoots(mounts);

	// Narrowed before anything is instrumented: the universe resolves off
	// directory entries and source maps alone, so what comes back is what the
	// shadow has to mirror rather than every file the mount holds.
	return narrowLuauRoots(mounts, {
		fileSystem,
		isCopyIgnored,
		rojoMounts: resolveRojoMounts(rojo),
		universe,
	});
}

/**
 * Resolve the rojo project, the luau roots, the non-luauRoot inputs hash and
 * the prior manifest — everything the rest of the run reads but never mutates.
 */
async function resolveCoverageInputsAsync(
	config: ResolvedConfig,
	coverageInclude: Array<string> | undefined,
	fileSystem: FileSystem,
	tsconfigReader: TsconfigReader,
): Promise<CoverageInputs> {
	const rojoProjectPath = findRojoProject(config, fileSystem);
	const isCopyIgnored = createCopyIgnoreMatcher(config.coverageCopyIgnorePatterns);
	const universe = resolveUniverse(config, coverageInclude, fileSystem);
	const narrowed = narrowConfiguredRoots({
		config,
		fileSystem,
		isCopyIgnored,
		rojoProjectPath,
		tsconfigReader,
		universe,
	});
	const luauRoots = narrowed.flatMap((entry) => entry.roots);
	const inputs = await resolveRojoInputsHashAsync(config, rojoProjectPath, luauRoots, fileSystem);
	const manifestPath = path.join(COVERAGE_DIR, COVERAGE_MANIFEST);

	return {
		buildManifestPath: path.join(COVERAGE_DIR, BUILD_MANIFEST_FILE),
		copyIgnoreHash: hashCopyIgnorePatterns(config.coverageCopyIgnorePatterns),
		fileSystem,
		hasResolvedInputs: inputs.resolved,
		isCopyIgnored,
		luauRoots,
		manifestPath,
		narrowed,
		previousManifest: loadCoverageManifest(fileSystem, manifestPath),
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
	{ copyIgnoreHash, fileSystem, luauRoots, previousManifest, universe }: CoverageInputs,
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

	if (!isIncremental && fileSystem.existsSync(COVERAGE_DIR)) {
		fileSystem.rmSync(COVERAGE_DIR, { recursive: true });
	}

	return isIncremental;
}

/**
 * One narrowed root, instrumented into the shadow directory that mirrors it.
 */
function instrumentOneRoot(
	{ fileSystem, isCopyIgnored, previousManifest, universe }: CoverageInputs,
	{ isBakeOwned, isIncremental, luauRoot }: ShadowPassSettings & { luauRoot: PosixRoot },
): ShadowRootResult {
	return prepareShadowRoot({
		fileSystem,
		isBakeOwned,
		isCopyIgnored,
		luauRoot,
		previousManifest,
		shadowDir: normalizeWindowsPath(path.join(COVERAGE_DIR, luauRoot)),
		universe,
		useIncremental: isIncremental,
	});
}

/**
 * The spine pass for single mode. The narrowed paths here are already the
 * source's own — this mode walks them from the invocation directory — so a
 * spine level names its own directory.
 */
function prepareSingleSpine(
	inputs: CoverageInputs,
	{ isBakeOwned }: ShadowPassSettings,
): PreparedSpine {
	return prepareSpine({
		fileSystem: inputs.fileSystem,
		isBakeOwned,
		isCopyIgnored: inputs.isCopyIgnored,
		narrowed: inputs.narrowed,
		previousNonInstrumented: inputs.previousManifest?.nonInstrumentedFiles,
		shadowRoot: COVERAGE_DIR,
		toSourcePath: (relativePath) => relativePath,
	});
}

/** Instrument every luauRoot into its shadow dir and merge the results. */
function prepareShadowRoots(inputs: CoverageInputs, pass: ShadowPassSettings): ShadowRootsResult {
	const files: Record<string, InstrumentedFileRecord> = {};
	const coverageRoots: Array<CoverageRoot> = [];
	const spine = prepareSingleSpine(inputs, pass);
	const nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord> = { ...spine.files };
	let hasChanges = spine.changed;

	for (const luauRoot of inputs.luauRoots) {
		const result = instrumentOneRoot(inputs, { ...pass, luauRoot });
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
