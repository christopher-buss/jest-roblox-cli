import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import type { InstrumentedFileRecord, NonInstrumentedFileRecord } from "./manifest.ts";

/**
 * One package root and the shadow directory standing in for it.
 */
export interface WorkspaceCoverageRoot {
	/**
	 * Path relative to the package directory (matches what rojo $path uses).
	 */
	luauRoot: PosixRoot;
	/** Absolute, POSIX-normalized path to the instrumented shadow directory. */
	shadowDir: string;
}

/**
 * One workspace package and its per-package coverage settings.
 */
export interface WorkspacePackageDescriptor {
	/** Package name. */
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
	 * mode's `> 0` gate in `prepare.ts:selectRawLuauRoots`.
	 */
	luauRoots?: Array<string> | undefined;
	/** Directory of the package. */
	packageDirectory: string;
	/** Path of the package's rojo project file. */
	rojoProjectPath: string;
	/**
	 * The package's own `rootDir` — what its coverage globs are written
	 * relative to. Defaults to `packageDirectory`, which is what `rootDir`
	 * itself defaults to; a package that points `rootDir` at a subdirectory
	 * writes its globs from there instead.
	 */
	rootDir?: string | undefined;
}

/**
 * A package's effective `coveragePathIgnorePatterns`, as both the compiled
 * root-matcher (used to skip instrumenting ignored directories) and the raw
 * patterns (carried onto the result so report-time aggregation can re-apply
 * them per-package against TS source paths).
 */
export interface PackageIgnore {
	/** Digest of `copyPatterns`, for the incremental gate. */
	copyDigest: string;
	/** This package's `coverageCopyIgnorePatterns` gate. */
	copyMatcher: CopyIgnoreMatcher;
	/** Returns `true` for a path the coverage ignore patterns exclude. */
	matcher: (filePath: string) => boolean;
	/** The raw `coveragePathIgnorePatterns`. */
	patterns: Array<string>;
}

/** The merged instrumentation output across one package's luau roots. */
export interface InstrumentedPackage {
	/** Each narrowed root paired with its shadow directory. */
	coverageRoots: Array<WorkspaceCoverageRoot>;
	/** The demoted levels, paired with the shadow copy that stands in. */
	coverageSpine: Array<WorkspaceCoverageRoot>;
	/** Instrumented files, keyed by manifest file key. */
	files: Record<string, InstrumentedFileRecord>;
	/** Files mirrored without probes, keyed by manifest file key. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
}
