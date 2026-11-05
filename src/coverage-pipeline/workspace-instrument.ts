import * as path from "node:path";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { canReuseCoverageManifest } from "./incremental-gate.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import type { Instrumenter } from "./instrumenter.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { loadPriorManifest } from "./prior-manifest.ts";
import type { ShadowRootResult } from "./shadow-root.ts";
import { prepareShadowRoot } from "./shadow-root.ts";
import { prepareSpine } from "./spine.ts";
import type {
	InstrumentedPackage,
	PackageIgnore,
	WorkspaceCoverageRoot,
	WorkspacePackageDescriptor,
} from "./workspace-prepare-types.ts";
import { narrowPackageRoots } from "./workspace-roots.ts";

/** What one package's instrumentation pass resolves for itself. */
export interface InstrumentPackageInputs {
	/** The package being instrumented. */
	descriptor: WorkspacePackageDescriptor;
	/** Filesystem holding the sources and the shadow. */
	fileSystem: FileSystem;
	/** The package's compiled ignore patterns. */
	ignore: PackageIgnore;
	/** Instruments one Luau file. */
	instrumenter: Instrumenter;
	/** Path of the package's previous Coverage Manifest. */
	manifestPath: string;
	/** Shadow directory the package's roots mirror into. */
	packageShadowRoot: string;
	/** Records phase timings. */
	timing: TimingCollector;
	/** Files that earn probes; absent when nothing narrows the run. */
	universe: InstrumentUniverse | undefined;
}

interface PackageIncrementalOptions {
	/** Digest of this package's copy-ignore list, for the incremental gate. */
	copyIgnoreHash: string;
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	luauRoots: Array<PosixRoot>;
	/** Each mount with the roots the universe narrowed it to. */
	narrowed: Array<NarrowedMount>;
	packageShadowRoot: string;
	previousManifest: CoverageManifest | undefined;
	universe: InstrumentUniverse | undefined;
}

interface InstrumentPackageOptions extends PackageIncrementalOptions {
	instrumenter: Instrumenter;
	isCopyIgnored: CopyIgnoreMatcher;
	isIncremental: boolean;
	timing: TimingCollector;
}

/**
 * Discover this package's roots, decide whether its cache survives, and
 * instrument what is left. `InstrumentPackageOptions extends
 * PackageIncrementalOptions`, so the decision and the instrumentation read one
 * options bag.
 * @param inputs - Package, filesystem, ignores, instrumenter and universe.
 * @returns The package coverage roots, spine and file records.
 */
export function instrumentPackage({
	descriptor,
	fileSystem,
	ignore,
	instrumenter,
	manifestPath,
	packageShadowRoot,
	timing,
	universe,
}: InstrumentPackageInputs): InstrumentedPackage {
	const narrowed = narrowPackageRoots({ descriptor, fileSystem, ignore, universe });
	const options: PackageIncrementalOptions = {
		copyIgnoreHash: ignore.copyDigest,
		descriptor,
		fileSystem,
		luauRoots: narrowed.flatMap((entry) => entry.roots),
		narrowed,
		packageShadowRoot,
		previousManifest: loadPriorManifest({
			fileSystem,
			label: "Workspace coverage manifest",
			manifestPath,
		}),
		universe,
	};

	return instrumentPackageRoots({
		...options,
		instrumenter,
		isCopyIgnored: ignore.copyMatcher,
		isIncremental: decidePackageIncremental(options),
		timing,
	});
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
 * @param options - Cache inputs of this package.
 * @returns `true` when the cached shadow tree is reused.
 */
function decidePackageIncremental({
	copyIgnoreHash,
	descriptor,
	fileSystem,
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
	if (!isIncremental && fileSystem.existsSync(packageShadowRoot)) {
		fileSystem.rmSync(packageShadowRoot, { recursive: true });
	}

	return isIncremental;
}

/**
 * One narrowed root, instrumented into the shadow directory that mirrors it.
 * @param relativeLuauRoot - Root, relative to the package directory.
 * @param options - Package instrumentation options.
 * @returns The instrumented shadow root.
 */
function instrumentOneRoot(
	relativeLuauRoot: string,
	{
		descriptor,
		fileSystem,
		instrumenter,
		isCopyIgnored,
		isIncremental,
		packageShadowRoot,
		previousManifest,
		timing,
		universe,
	}: InstrumentPackageOptions,
): ShadowRootResult {
	return prepareShadowRoot({
		fileSystem,
		instrumenter,
		isCopyIgnored,
		luauRoot: toPosixRoot(path.join(descriptor.packageDirectory, relativeLuauRoot)),
		previousManifest,
		shadowDir: normalizeWindowsPath(path.join(packageShadowRoot, relativeLuauRoot)),
		timing,
		universe,
		useIncremental: isIncremental,
	});
}

/**
 * Instrument each of the package's luau roots into its shadow tree.
 * @param options - Package instrumentation options.
 * @returns The package coverage roots, spine and file records.
 */
function instrumentPackageRoots(options: InstrumentPackageOptions): InstrumentedPackage {
	const { descriptor, fileSystem, isCopyIgnored, luauRoots, narrowed, packageShadowRoot } =
		options;
	const coverageRoots: Array<WorkspaceCoverageRoot> = [];
	const allFiles: Record<string, InstrumentedFileRecord> = {};
	// The narrowed paths are package-relative here, so a spine level has to be
	// joined back onto the package to name the directory it copies. `changed`
	// is dropped rather than ignored by accident: this mode rebuilds the shared
	// place on every run, so nothing downstream asks.
	const spine = prepareSpine({
		fileSystem,
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
