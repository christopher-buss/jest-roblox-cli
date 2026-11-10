import type {
	BuildManifestArtifact,
	BuildManifestFileRecord,
} from "../coverage-data/build-manifest.ts";
import type { CoverageLayout } from "../coverage-data/coverage-layout.ts";
import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import type { ShadowTree } from "./shadow-tree.ts";

/** What a coverage run's preparation produced. */
export interface PrepareCoverageResult {
	/** Shared UUID for the sibling Build + Coverage manifests. */
	buildId: string;
	/** The instrumented place this run resolved (built fresh or reused). */
	coveragePlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, for the caller's Build Manifest. */
	files: Record<string, BuildManifestFileRecord>;
	/** Host time spent instrumenting into the shadow tree. */
	instrumentMs: number;
	/** The Coverage Manifest this run wrote. */
	manifest: CoverageManifest;
	/** Path of the instrumented place file. */
	placeFile: string;
	/** Whether the place was rebuilt this run rather than reused. */
	rebuilt: boolean;
	/** Host time spent on the stub bake, reuse gate and place build. */
	stagingMs: number;
}

/** Everything resolved from config before any shadow dir is touched. */
export interface CoverageInputs {
	/** Filesystem the shadow tree lives on. */
	fileSystem: FileSystem;
	/** Where the run's coverage artifacts live under `rootDir`. */
	layout: CoverageLayout;
	/** Each rojo mount with the roots the universe narrowed it to. */
	narrowed: Array<NarrowedMount>;
	/** Digest of the rojo build inputs, recorded in the Coverage Manifest. */
	rojoInputsHash: string | undefined;
	/** Path of the rojo project file. */
	rojoProjectPath: string;
	/** Absent when the config narrows nothing — the whole root is probed. */
	universe: InstrumentUniverse | undefined;
}

/** What the instrumentation phase leaves behind for the place build. */
export interface InstrumentedCoverage {
	/** Inputs the phase ran against. */
	inputs: CoverageInputs;
	/** The instrumented shadow tree. */
	shadow: ShadowTree;
}
