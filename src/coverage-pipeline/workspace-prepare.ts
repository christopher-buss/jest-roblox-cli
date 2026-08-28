import { collectPaths, loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import picomatch from "picomatch";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { atomicWrite } from "../utils/atomic-write.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { BuildManifestArtifact } from "./build-manifest.ts";
import { BUILD_MANIFEST_FILE, emitBuildManifest, toBuildManifestFiles } from "./build-manifest.ts";
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
import { MANIFEST_VERSION, readManifest } from "./manifest.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowLuauRoots } from "./narrow-roots.ts";
import { isWithinRoot } from "./redirect-path.ts";
import { collectRojoMounts, unreachableRootWarning } from "./root-reachability.ts";
import type { ShadowRootResult } from "./shadow-root.ts";
import { isNonInstrumentedFile, prepareShadowRoot } from "./shadow-root.ts";
import { prepareSpine } from "./spine.ts";

const WORKSPACE_COVERAGE_DIR = ".jest-roblox/workspace";

export interface WorkspacePackageDescriptor {
	name: string;
	/**
	 * Per-package `collectCoverageFrom`. Narrows instrumentation to the files
	 * this package will actually report on, so the run does not ship probe
	 * counts the report discards. Undefined instruments the whole root.
	 */
	collectCoverageFrom?: Array<string> | undefined;
	/**
	 * Per-package `coverageCache` opt-out. When undefined, defaults to
	 * `DEFAULT_CONFIG.coverageCache` (true). Workspace mode reads this knob
	 * per-package only; the workspace-root `config.coverageCache` is
	 * intentionally not consulted.
	 */
	coverageCache?: boolean | undefined;
	/**
	 * Per-package `coverageCopyIgnorePatterns`. When undefined, falls back to
	 * `DEFAULT_CONFIG.coverageCopyIgnorePatterns` — workspace mode reads this
	 * knob per-package only, like every other coverage knob here.
	 */
	coverageCopyIgnorePatterns?: Array<string> | undefined;
	/**
	 * Per-package `coveragePathIgnorePatterns`. When undefined, the matcher
	 * falls back to `DEFAULT_CONFIG.coveragePathIgnorePatterns` — workspace
	 * mode reads this knob per-package only. An empty array means "no
	 * ignore patterns" (user opted out of every default pattern).
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/**
	 * Per-package override for `luauRoots`. When set to a non-empty array,
	 * `discoverPackageLuauRoots` skips the rojo-tree walk and uses these roots
	 * directly (after validating each entry against the rojo `$path` mounts).
	 * An empty array or undefined falls back to the rojo walk — matches single
	 * mode's `> 0` gate at `prepare.ts:resolveLuauRootsWithRojo`.
	 */
	luauRoots?: Array<string> | undefined;
	packageDirectory: string;
	rojoProjectPath: string;
	/**
	 * The package's own `rootDir` — what its coverage globs are written
	 * relative to. Defaults to `packageDirectory`, which is what `rootDir`
	 * itself defaults to; a package that points `rootDir` at a subdirectory
	 * writes its globs from there instead.
	 */
	rootDir?: string | undefined;
}

export interface WorkspaceCoverageRoot {
	/**
	 * Path relative to the package directory (matches what rojo $path uses).
	 */
	luauRoot: string;
	/** Absolute, POSIX-normalized path to the instrumented shadow directory. */
	shadowDir: string;
}

export interface WorkspacePackageCoverage {
	/**
	 * This package's effective `coveragePathIgnorePatterns` (per-package
	 * override or the `DEFAULT_CONFIG` fallback). Always populated by
	 * `prepareForPackage`; optional only so test stubs need not restate it.
	 * Carried so report-time aggregation applies the same patterns per-package
	 * that instrumentation used for roots.
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	coverageRoots: Array<WorkspaceCoverageRoot>;
	/**
	 * The directories between each `coverageRoots` entry and the `$path` mount
	 * above it, paired with the shadow copy of that directory's own loose
	 * files. Synthesis demotes each one so the roots below it can be swapped.
	 */
	coverageSpine: Array<WorkspaceCoverageRoot>;
	manifest: CoverageManifest;
	manifestPath: string;
	pkg: string;
	/**
	 * The anchor this package's coverage globs were resolved against. Carried
	 * for the same reason as `coveragePathIgnorePatterns`: the report has to
	 * judge on exactly what instrumentation judged on, and re-deriving the
	 * anchor from a config downstream is how the two would drift apart.
	 */
	rootDir: string;
}

export interface PrepareWorkspaceCoverageOptions {
	packages: Array<WorkspacePackageDescriptor>;
	/**
	 * Orchestration profiler; records the coverage sub-phases per instrumented
	 * root.
	 */
	timing?: TimingCollector | undefined;
	workspaceRoot: string;
}

/**
 * A package's effective `coveragePathIgnorePatterns`, as both the compiled
 * root-matcher (used to skip instrumenting ignored directories) and the raw
 * patterns (carried onto the result so report-time aggregation can re-apply
 * them per-package against TS source paths).
 */
interface PackageIgnore {
	/** Digest of `copyPatterns`, for the incremental gate. */
	copyDigest: string;
	/** This package's `coverageCopyIgnorePatterns` gate. */
	copyMatcher: CopyIgnoreMatcher;
	matcher: (filePath: string) => boolean;
	patterns: Array<string>;
}

/** Where one package's coverage artifacts are published. */
interface PackagePaths {
	manifestPath: string;
	packageShadowRoot: string;
}

interface PackageIncrementalOptions {
	/** Digest of this package's copy-ignore list, for the incremental gate. */
	copyIgnoreHash: string;
	descriptor: WorkspacePackageDescriptor;
	luauRoots: Array<string>;
	/** Each mount with the roots the universe narrowed it to. */
	narrowed: Array<NarrowedMount>;
	packageShadowRoot: string;
	previousManifest: CoverageManifest | undefined;
	universe: InstrumentUniverse | undefined;
}

interface InstrumentPackageOptions extends PackageIncrementalOptions {
	isCopyIgnored: CopyIgnoreMatcher;
	isIncremental: boolean;
	timing: TimingCollector;
}

/** The merged instrumentation output across one package's luau roots. */
interface InstrumentedPackage {
	coverageRoots: Array<WorkspaceCoverageRoot>;
	coverageSpine: Array<WorkspaceCoverageRoot>;
	files: Record<string, InstrumentedFileRecord>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
}

/** What narrowing one package's roots reads. */
interface NarrowPackageOptions {
	descriptor: WorkspacePackageDescriptor;
	ignore: PackageIgnore;
	universe: InstrumentUniverse | undefined;
}

/** What one package's instrumentation pass resolves for itself. */
interface InstrumentPackageInputs {
	descriptor: WorkspacePackageDescriptor;
	ignore: PackageIgnore;
	manifestPath: string;
	packageShadowRoot: string;
	timing: TimingCollector;
	universe: InstrumentUniverse | undefined;
}

/** What every root-discovery pass over one package reads. */
interface DiscoverRootsOptions {
	descriptor: WorkspacePackageDescriptor;
	matchesIgnored: (filePath: string) => boolean;
	/** The package's rojo tree, nested projects already inlined. */
	tree: RojoTreeNode;
}

/** One explicit `luauRoots` entry, weighed against the package's rojo tree. */
interface RootCheck {
	descriptor: WorkspacePackageDescriptor;
	/** Absolute `$path` mounts of the package's rojo project. */
	mounts: Set<string>;
	/** The entry as the user wrote it. */
	rawRoot: string;
}

/** One package's manifest write, after its roots are instrumented. */
interface WritePackageManifestOptions {
	copyIgnoreHash: string;
	instrumented: InstrumentedPackage;
	manifestPath: string;
	packageShadowRoot: string;
	universe: InstrumentUniverse | undefined;
}

/**
 * Instrument each workspace package into its own shadow directory and write a
 * per-package manifest. Returns one `WorkspacePackageCoverage` entry per input
 * package; packages with no instrumentable luau roots return an empty
 * `coverageRoots` array (the caller then skips coverage rewrites for that
 * package while still picking up an empty manifest for parity).
 */
export function prepareWorkspaceCoverage(
	options: PrepareWorkspaceCoverageOptions,
): Array<WorkspacePackageCoverage> {
	const { packages, workspaceRoot } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	// Workspace mode reads `coveragePathIgnorePatterns` per-package only.
	// Hoist the DEFAULT_CONFIG matcher so packages that don't override the
	// field share one picomatch compile; the workspace-root config is
	// intentionally not threaded through here.
	const defaultMatcher = createIgnoreMatcher(DEFAULT_CONFIG.coveragePathIgnorePatterns);
	// Hoisted for the same reason, one knob over: nothing else in the workspace
	// re-parses the defaults per package.
	const defaultCopyMatcher = createCopyIgnoreMatcher(DEFAULT_CONFIG.coverageCopyIgnorePatterns);

	return packages.map((descriptor) => {
		const copyPatterns =
			descriptor.coverageCopyIgnorePatterns ?? DEFAULT_CONFIG.coverageCopyIgnorePatterns;
		const ignore: PackageIgnore = {
			copyDigest: hashCopyIgnorePatterns(copyPatterns),
			copyMatcher:
				descriptor.coverageCopyIgnorePatterns !== undefined
					? createCopyIgnoreMatcher(descriptor.coverageCopyIgnorePatterns)
					: defaultCopyMatcher,
			matcher:
				descriptor.coveragePathIgnorePatterns !== undefined
					? createIgnoreMatcher(descriptor.coveragePathIgnorePatterns)
					: defaultMatcher,
			patterns:
				descriptor.coveragePathIgnorePatterns ?? DEFAULT_CONFIG.coveragePathIgnorePatterns,
		};
		return prepareForPackage(descriptor, workspaceRoot, ignore, timing);
	});
}

/**
 * Emit a per-package Build Manifest next to each Coverage Manifest, after the
 * shared place build has succeeded. Every package records the one shared
 * instrumented place as its `coveragePlace` and reuses its Coverage Manifest's
 * `buildId`, so the sibling manifests cross-link. `projects` is left empty for
 * a later slice to populate, and no Clean Place is emitted from the workspace
 * path (it records `coveragePlace` only).
 */
export function emitWorkspaceBuildManifests(
	entries: Array<WorkspacePackageCoverage>,
	coveragePlace: BuildManifestArtifact,
): void {
	for (const entry of entries) {
		// The Build Manifest is the Coverage Manifest's sibling — same directory.
		const buildManifestPath = normalizeWindowsPath(
			path.join(path.dirname(entry.manifestPath), BUILD_MANIFEST_FILE),
		);
		emitBuildManifest(buildManifestPath, {
			buildId: entry.manifest.buildId,
			coveragePlace,
			files: toBuildManifestFiles(entry.manifest.files),
			generatedAt: entry.manifest.generatedAt,
			projects: [],
			rebuilt: true,
		});
	}
}

/**
 * Map an npm-style package name (`@scope/name`) to a filesystem-safe directory
 * segment. Replaces "/" with "-" so the on-disk path is one segment deep.
 */
function safePackageName(name: string): string {
	return name.replaceAll("/", "-");
}

/** Where one package's shadow tree and its Coverage Manifest live on disk. */
function resolvePackagePaths(name: string, workspaceRoot: string): PackagePaths {
	const packageShadowRoot = path.join(
		workspaceRoot,
		WORKSPACE_COVERAGE_DIR,
		safePackageName(name),
		"coverage",
	);

	return {
		manifestPath: normalizeWindowsPath(path.join(packageShadowRoot, "coverage-manifest.json")),
		packageShadowRoot,
	};
}

function writePackageManifest({
	copyIgnoreHash,
	instrumented,
	manifestPath,
	packageShadowRoot,
	universe,
}: WritePackageManifestOptions): CoverageManifest {
	const generatedAtDate = new Date();
	const manifest: CoverageManifest = {
		buildId: crypto.randomUUID(),
		copyIgnoreHash,
		coverageUniverseHash: universe?.digest,
		files: instrumented.files,
		generatedAt: generatedAtDate.toISOString(),
		instrumenterVersion: INSTRUMENTER_VERSION,
		luauRoots: instrumented.coverageRoots.map((entry) => entry.shadowDir),
		nonInstrumentedFiles: instrumented.nonInstrumentedFiles,
		shadowDir: normalizeWindowsPath(packageShadowRoot),
		version: MANIFEST_VERSION,
	};

	// atomicWrite creates the manifest's parent directory, so a package with no
	// instrumentable luau roots (the loop above ran zero times, leaving
	// packageShadowRoot uncreated) still gets a manifest written.
	atomicWrite(manifestPath, JSON.stringify(manifest, undefined, "\t"));

	return manifest;
}

/**
 * The anchor this package's coverage globs resolve against. `rootDir` defaults
 * to the package directory the same way the config loader defaults it, so a
 * descriptor built by a caller with no coverage stake — the staging and
 * preflight paths — need not state one.
 */
function resolvePackageAnchor(descriptor: WorkspacePackageDescriptor): string {
	return descriptor.rootDir ?? descriptor.packageDirectory;
}

/**
 * The package's coverage universe, built from the same patterns its own report
 * and threshold gate use — so a file earns probes exactly when that package
 * would report on it. `undefined` when the package names no coverage globs.
 *
 * Deliberately no `deriveCoverageFromIncludes` fallback, unlike multi mode:
 * the workspace report has none either (`workspace-aggregate.ts` filters on the
 * raw per-package value), and adding one here would probe against a universe
 * the package's own report never applies.
 */
function resolvePackageUniverse(
	descriptor: WorkspacePackageDescriptor,
	ignore: PackageIgnore,
): InstrumentUniverse | undefined {
	return createInstrumentUniverse({
		ignore: ignore.patterns,
		include: descriptor.collectCoverageFrom,
		rootDir: resolvePackageAnchor(descriptor),
	});
}

/**
 * The package's rojo tree with its nested `.project.json` mounts inlined. Read
 * once per package: root discovery and the mount set the demote is judged
 * against have to see the same tree, and a nested mount is a mount.
 */
function resolvePackageTree(descriptor: WorkspacePackageDescriptor): RojoTreeNode {
	const project = loadRojoProject(descriptor.rojoProjectPath);
	return resolveNestedProjects(project.tree, path.dirname(descriptor.rojoProjectPath));
}

function isInstrumentableLuauFile(filename: string): boolean {
	if (!filename.endsWith(".luau") && !filename.endsWith(".lua")) {
		return false;
	}

	// Mirror the pipeline's discovery filter: instrumentation skips spec,
	// test, and snapshot files. A directory containing only those would feed
	// `instrumentRoot` zero files and produce an empty shadow dir, which the
	// synthesizer would then swap a parent `$path` into and the demote pass
	// inside `walkToLeaf` would fail to walk. Defer the suffix set to
	// `discover-files.ts` so this filter cannot drift from the
	// instrumenter's view.
	return !isNonInstrumentedFile(filename);
}

function containsLuauFiles(directoryPath: string): boolean {
	const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
	return entries.some((entry) => {
		if (entry.isFile() && isInstrumentableLuauFile(entry.name)) {
			return true;
		}

		if (entry.isDirectory()) {
			return containsLuauFiles(path.join(directoryPath, entry.name));
		}

		return false;
	});
}

// Mirrors the roblox-ts compiler: it emits `RuntimeLib.lua` (and `Promise.lua`)
// into the project's rbxts include dir. Instrumenting vendor code wastes work
// and forces every `TS.import` through cov probes.
function isRbxtsIncludeRoot(directoryPath: string): boolean {
	return (
		fs.existsSync(path.join(directoryPath, "RuntimeLib.lua")) ||
		fs.existsSync(path.join(directoryPath, "RuntimeLib.luau"))
	);
}

/**
 * Common filter applied to every candidate coverage root regardless of how it
 * was discovered (rojo walk or per-pkg `luauRoots`). Returns `true` when the
 * directory should be instrumented.
 *
 * `isRbxtsIncludeRoot` (two `existsSync`s) precedes the recursive
 * `containsLuauFiles` scan so include dirs short-circuit out before the deep
 * walk.
 */
function isInstrumentableRoot(
	absolutePath: string,
	relativePath: string,
	matchesIgnored: (filePath: string) => boolean,
): boolean {
	if (matchesIgnored(relativePath)) {
		return false;
	}

	if (!fs.existsSync(absolutePath)) {
		return false;
	}

	if (!fs.statSync(absolutePath).isDirectory()) {
		return false;
	}

	if (isRbxtsIncludeRoot(absolutePath)) {
		return false;
	}

	return containsLuauFiles(absolutePath);
}

/**
 * Why this package cannot take `rawRoot` as a coverage root, or `undefined`
 * when it can.
 *
 * A root has to name a directory strictly inside the package: the shadow tree
 * mirrors it under `packageShadowRoot` and the manifest keys the report reads
 * are package-relative. A path elsewhere in the rojo tree belongs to whichever
 * package owns it, and the package directory itself is the package, not a root
 * within it. Past that, the root has to be one the synthesized place will
 * actually load.
 */
function rejectRoot({ descriptor, mounts, rawRoot }: RootCheck): string | undefined {
	const packageDirectory = normalizeWindowsPath(descriptor.packageDirectory);
	const root = normalizeWindowsPath(path.resolve(descriptor.packageDirectory, rawRoot));
	// Judged on the resolved path, not the spelling: `./` and `src/..` name the
	// package root, `src/../../bar` escapes it, and a directory honestly called
	// `..cache` is none of those. `isWithinRoot` admits the root itself, hence
	// the inequality — the package directory is the package, not a root in it.
	if (root === packageDirectory || !isWithinRoot(root, packageDirectory)) {
		return `Warning: luauRoot "${rawRoot}" in ${descriptor.name} is not a directory inside the package, so it reports no coverage.\n`;
	}

	return unreachableRootWarning({
		base: descriptor.packageDirectory,
		mounts,
		rawRoot,
		subject: descriptor.name,
	});
}

function discoverFromLuauRoots(
	{ descriptor, matchesIgnored, tree }: DiscoverRootsOptions,
	luauRoots: Array<string>,
): Array<string> {
	const mounts = collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath));
	const seen = new Set<string>();
	const result: Array<string> = [];
	for (const rawRoot of luauRoots) {
		const absolute = path.resolve(descriptor.packageDirectory, rawRoot);
		// Canonical, so two spellings of one directory dedupe to one root and
		// the shadow tree mirrors it at the path the manifest names.
		const relative = normalizeWindowsPath(path.relative(descriptor.packageDirectory, absolute));
		if (seen.has(relative)) {
			continue;
		}

		const warning = rejectRoot({ descriptor, mounts, rawRoot });
		if (warning !== undefined) {
			process.stderr.write(warning);
			continue;
		}

		if (!isInstrumentableRoot(absolute, relative, matchesIgnored)) {
			continue;
		}

		seen.add(relative);
		result.push(relative);
	}

	return result;
}

function collectRojoMountedPaths(tree: RojoTreeNode): Array<string> {
	const collected: Array<string> = [];
	collectPaths(tree, collected);
	return collected;
}

function discoverFromRojoWalk({
	descriptor,
	matchesIgnored,
	tree,
}: DiscoverRootsOptions): Array<string> {
	const collected = collectRojoMountedPaths(tree);
	const rojoDirectory = path.dirname(descriptor.rojoProjectPath);
	const seen = new Set<string>();
	const result: Array<string> = [];
	for (const rawPath of collected) {
		// path.resolve treats host-absolute rawPaths as already-resolved (passes
		// them through verbatim) and resolves relative ones against the rojo
		// dir, so no separate isAbsolute branch is needed. The relativize below
		// is what decides an absolute mount's fate: one inside the package is
		// kept, one outside escapes and is dropped.
		const absolute = path.resolve(rojoDirectory, rawPath);
		const relative = normalizeWindowsPath(path.relative(descriptor.packageDirectory, absolute));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			continue;
		}

		if (seen.has(relative) || !isInstrumentableRoot(absolute, relative, matchesIgnored)) {
			continue;
		}

		seen.add(relative);
		result.push(relative);
	}

	return result;
}

function discoverPackageLuauRoots(options: DiscoverRootsOptions): Array<string> {
	const { descriptor } = options;
	// Short-circuit when the package opts into explicit luauRoots — mirrors
	// single mode's `> 0` gate at `prepare.ts:resolveLuauRootsWithRojo:187`.
	// Empty array falls through to the rojo walk (auto-detect).
	if (descriptor.luauRoots !== undefined && descriptor.luauRoots.length > 0) {
		return discoverFromLuauRoots(options, descriptor.luauRoots);
	}

	return discoverFromRojoWalk(options);
}

/**
 * Narrow the package's discovered roots to the directories its coverage
 * universe resolves to, in package-relative terms.
 *
 * The walk itself runs on absolute paths, because that is the frame the
 * universe judges a compiled file in; the answer comes back relative, because
 * that is the frame the shadow tree and the manifest are keyed in.
 */
function narrowPackageRoots({
	descriptor,
	ignore,
	universe,
}: NarrowPackageOptions): Array<NarrowedMount> {
	function toAbsolute(relative: string): string {
		return normalizeWindowsPath(path.join(descriptor.packageDirectory, relative));
	}

	function toRelative(absolute: string): string {
		return normalizeWindowsPath(path.relative(descriptor.packageDirectory, absolute));
	}

	const tree = resolvePackageTree(descriptor);
	const narrowed = narrowLuauRoots(
		discoverPackageLuauRoots({ descriptor, matchesIgnored: ignore.matcher, tree }).map(
			toAbsolute,
		),
		{
			isCopyIgnored: ignore.copyMatcher,
			rojoMounts: collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath)),
			universe,
		},
	);

	return narrowed.map((entry) => {
		return {
			luauRoot: toRelative(entry.luauRoot),
			roots: entry.roots.map(toRelative),
			spine: entry.spine.map(toRelative),
		};
	});
}

function loadPackageManifest(manifestPath: string): CoverageManifest | undefined {
	const result = readManifest(manifestPath);
	switch (result.kind) {
		case "invalid": {
			process.stderr.write(
				`Warning: Workspace coverage manifest is invalid (cache discarded): ${result.summary}\n`,
			);
			return undefined;
		}
		case "malformed-json": {
			process.stderr.write(
				"Warning: Workspace coverage manifest is malformed JSON (cache discarded)\n",
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

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}

	for (const value of a) {
		if (!b.has(value)) {
			return false;
		}
	}

	return true;
}

/**
 * Decide whether this package can reuse its cached shadow tree, nuking the
 * shadow root when it can't.
 */
function decidePackageIncremental({
	copyIgnoreHash,
	descriptor,
	luauRoots,
	packageShadowRoot,
	previousManifest,
	universe,
}: PackageIncrementalOptions): boolean {
	const isCoverageCacheEnabled = descriptor.coverageCache ?? DEFAULT_CONFIG.coverageCache;
	let isIncremental = canReuseCoverageManifest(previousManifest, {
		copyIgnoreHash,
		coverageCache: isCoverageCacheEnabled,
		universe,
	});

	// When the user shrinks `luauRoots` (or adds new ignore patterns)
	// between runs, previously-instrumented mounts disappear from the new set
	// but their shadow files remain on disk. `prepareShadowRoot` only merges
	// (cpSync), so a stale `vendored-packages/dep/init.luau` would survive
	// into the redirected `$path` mount and the runtime would load it. Force
	// a cold rebuild for that package so the rmSync below nukes the shadow.
	if (isIncremental && previousManifest !== undefined) {
		const computedShadowDirectories = new Set(
			luauRoots.map((relative) => {
				return normalizeWindowsPath(path.join(packageShadowRoot, relative));
			}),
		);
		const previousShadowDirectories = new Set(previousManifest.luauRoots);
		if (!setsEqual(computedShadowDirectories, previousShadowDirectories)) {
			isIncremental = false;
		}
	}

	// Mirror prepareCoverage's cold-path nuke (prepare.ts) so files deleted
	// from source between runs don't survive into the redirected `$path`
	// mount. `prepareShadowRoot`'s cpSync merges; without an explicit rmSync
	// here a stale `*.spec.luau` could still be discovered at runtime.
	if (!isIncremental && fs.existsSync(packageShadowRoot)) {
		fs.rmSync(packageShadowRoot, { recursive: true });
	}

	return isIncremental;
}

/**
 * One narrowed root, instrumented into the shadow directory that mirrors it.
 */
function instrumentOneRoot(
	relativeLuauRoot: string,
	{
		descriptor,
		isCopyIgnored,
		isIncremental,
		packageShadowRoot,
		previousManifest,
		timing,
		universe,
	}: InstrumentPackageOptions,
): ShadowRootResult {
	return prepareShadowRoot({
		isCopyIgnored,
		luauRoot: normalizeWindowsPath(path.join(descriptor.packageDirectory, relativeLuauRoot)),
		previousManifest,
		shadowDir: normalizeWindowsPath(path.join(packageShadowRoot, relativeLuauRoot)),
		timing,
		universe,
		useIncremental: isIncremental,
	});
}

/** Instrument each of the package's luau roots into its shadow tree. */
function instrumentPackageRoots(options: InstrumentPackageOptions): InstrumentedPackage {
	const { descriptor, isCopyIgnored, luauRoots, narrowed, packageShadowRoot } = options;
	const coverageRoots: Array<WorkspaceCoverageRoot> = [];
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	// The narrowed paths are package-relative here, so a spine level has to be
	// joined back onto the package to name the directory it copies. `changed`
	// is dropped rather than ignored by accident: this mode rebuilds the shared
	// place on every run, so nothing downstream asks.
	const spine = prepareSpine({
		isCopyIgnored,
		narrowed,
		previousNonInstrumented: options.previousManifest?.nonInstrumentedFiles,
		shadowRoot: packageShadowRoot,
		toSourcePath: (relativePath) => {
			return normalizeWindowsPath(path.join(descriptor.packageDirectory, relativePath));
		},
	});
	const allNonInstrumented: Record<string, NonInstrumentedFileRecord> = { ...spine.files };

	for (const relativeLuauRoot of luauRoots) {
		const result = instrumentOneRoot(relativeLuauRoot, options);

		Object.assign(allFiles, result.files);
		Object.assign(allNonInstrumented, result.nonInstrumentedFiles);
		coverageRoots.push({ luauRoot: relativeLuauRoot, shadowDir: result.shadowDir });
	}

	return {
		coverageRoots,
		coverageSpine: spine.directories,
		files: allFiles,
		nonInstrumentedFiles: allNonInstrumented,
	};
}

/**
 * Discover this package's roots, decide whether its cache survives, and
 * instrument what is left. `InstrumentPackageOptions extends
 * PackageIncrementalOptions`, so the decision and the instrumentation read one
 * options bag.
 */
function instrumentPackage({
	descriptor,
	ignore,
	manifestPath,
	packageShadowRoot,
	timing,
	universe,
}: InstrumentPackageInputs): InstrumentedPackage {
	const narrowed = narrowPackageRoots({ descriptor, ignore, universe });
	const options: PackageIncrementalOptions = {
		copyIgnoreHash: ignore.copyDigest,
		descriptor,
		luauRoots: narrowed.flatMap((entry) => entry.roots),
		narrowed,
		packageShadowRoot,
		previousManifest: loadPackageManifest(manifestPath),
		universe,
	};

	return instrumentPackageRoots({
		...options,
		isCopyIgnored: ignore.copyMatcher,
		isIncremental: decidePackageIncremental(options),
		timing,
	});
}

function prepareForPackage(
	descriptor: WorkspacePackageDescriptor,
	workspaceRoot: string,
	ignore: PackageIgnore,
	timing: TimingCollector,
): WorkspacePackageCoverage {
	const { manifestPath, packageShadowRoot } = resolvePackagePaths(descriptor.name, workspaceRoot);

	const universe = resolvePackageUniverse(descriptor, ignore);
	const instrumented = instrumentPackage({
		descriptor,
		ignore,
		manifestPath,
		packageShadowRoot,
		timing,
		universe,
	});
	const manifest = writePackageManifest({
		copyIgnoreHash: ignore.copyDigest,
		instrumented,
		manifestPath,
		packageShadowRoot,
		universe,
	});

	return {
		coveragePathIgnorePatterns: ignore.patterns,
		coverageRoots: instrumented.coverageRoots,
		coverageSpine: instrumented.coverageSpine,
		manifest,
		manifestPath,
		pkg: descriptor.name,
		rootDir: resolvePackageAnchor(descriptor),
	};
}

function createIgnoreMatcher(patterns: Array<string>): (filePath: string) => boolean {
	return picomatch(patterns, { contains: true });
}
