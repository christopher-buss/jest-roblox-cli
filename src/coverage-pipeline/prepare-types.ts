import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import type { CoverageRoot } from "../staging/synthesizer-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { BuildManifestArtifact, BuildManifestFileRecord } from "./build-manifest.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import type {
	CoverageManifest,
	InstrumentedFileRecord,
	NonInstrumentedFileRecord,
} from "./manifest.ts";
import type { NarrowedMount } from "./narrow-roots.ts";

/**
 * Everything a coverage run's preparation produced for the run and its
 * manifests.
 */
export interface PrepareCoverageResult {
	/** Shared UUID for the sibling Build + Coverage manifests. */
	buildId: string;
	/**
	 * The Code Bundle beside the place, present only when the caller asked for
	 * a harness. Written on every run, reused place or not.
	 */
	codeBundle?: CodeBundleArtifact | undefined;
	/** The instrumented place this run resolved (built fresh or reused). */
	coveragePlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, for the caller's Build Manifest. */
	files: Record<string, BuildManifestFileRecord>;
	/**
	 * Host time spent instrumenting into the shadow tree — the only part of
	 * this call a run reports as coverage.
	 */
	instrumentMs: number;
	/** The Coverage Manifest this run wrote. */
	manifest: CoverageManifest;
	/** Path of the instrumented place file. */
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

/** Everything resolved from config before any shadow dir is touched. */
export interface CoverageInputs {
	/** Where the Build Manifest is written. */
	buildManifestPath: string;
	/** Digest of the copy-ignore list, for the incremental gate. */
	copyIgnoreHash: string;
	/** Filesystem the shadow tree lives on. */
	fileSystem: FileSystem;
	/** The compiled `coverageCopyIgnorePatterns` gate for every root. */
	isCopyIgnored: CopyIgnoreMatcher;
	/** Every narrowed root, flattened across mounts. */
	luauRoots: Array<PosixRoot>;
	/** Where the Coverage Manifest is written. */
	manifestPath: string;
	/**
	 * Each rojo mount with the roots the universe narrowed it to. Carried
	 * whole because the spine mirror reads `coverageCopyIgnorePatterns` in the
	 * mount's own frame, which a flattened root list would have lost.
	 */
	narrowed: Array<NarrowedMount>;
	/** Coverage Manifest of the last run, if one loads. */
	previousManifest: CoverageManifest | undefined;
	/** Digest of the rojo build inputs, recorded in the Coverage Manifest. */
	rojoInputsHash: string | undefined;
	/** Path of the rojo project file. */
	rojoProjectPath: string;
	/** Absent when the config narrows nothing — the whole root is probed. */
	universe: InstrumentUniverse | undefined;
}

/** The merged instrumentation output across every luauRoot. */
export interface ShadowRootsResult {
	/** `true` when any shadow file was written or removed. */
	changed: boolean;
	/** Each luauRoot paired with its shadow copy. */
	coverageRoots: Array<CoverageRoot>;
	/** The demoted levels, paired with the shadow copy that stands in. */
	coverageSpine: Array<CoverageRoot>;
	/** Instrumented files, keyed by manifest file key. */
	files: Record<string, InstrumentedFileRecord>;
	/** Files mirrored without probes, keyed by manifest file key. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
}

/** What the instrumentation phase leaves behind for the place build. */
export interface InstrumentedCoverage {
	/** Inputs the phase ran against. */
	inputs: CoverageInputs;
	/** `true` when the cached shadow tree was reused. */
	isIncremental: boolean;
	/** Merged shadow output. */
	shadow: ShadowRootsResult;
}
