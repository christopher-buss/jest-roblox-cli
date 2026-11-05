import * as path from "node:path";

import {
	emitWorkspaceBuildManifests,
	type WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import { describePlaceFile } from "../progress/stages.ts";
import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import type { PlaceReuseOptions } from "../staging/place-builder.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { PackageDescriptor } from "../staging/synthesizer-types.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { PrepareCoverage } from "./coverage-attach.ts";
import { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";
import type { LoadedPackage } from "./package-loader.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";
import type { WorkspaceTestSelection } from "./test-selection.ts";

const SYNTHESIZED_PROJECT_FILE = "synthesized.project.json";
const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";
const PLACE_REUSE_FILE = "synthesized.place-cache.json";
/**
 * Sits beside the reuse record and shares its lifetime: both answer for the
 * same set of inputs, and a run that discards one has nothing to gain by
 * keeping the other.
 */
const INPUT_DIGEST_FILE = "synthesized.input-digests";

/** The staged place and what its staging cost. */
export interface StagedWorkspacePlace {
	/**
	 * The Code Bundle split out of the place, present only when the caller
	 * asked for a harness. Written on every run, reused place or not.
	 */
	codeBundle?: CodeBundleArtifact | undefined;
	/** Coverage per instrumented package, for the report layer. */
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	/**
	 * Host time spent instrumenting the packages that opted into coverage — the
	 * phase multi reports as its coverage bake. 0 when no package opted in, so
	 * a run that collected no coverage reports no coverage time.
	 */
	coverageMs: number;
	/** Path of the synthesized place file. */
	placeFile: string;
	/**
	 * Host time spent on the rest of the staging: the stubs and the rojo build,
	 * which a run pays whether or not it collects coverage.
	 */
	stagingMs: number;
}

/** What one workspace run's staging reads, and where it writes. */
export interface StageWorkspacePlaceOptions {
	/** Directory the place and its caches are written to. */
	cacheDirectory: string;
	/** Runner that spawns the rojo build. */
	childProcess: ChildProcessRunner;
	/**
	 * Build a Harness Place, splitting the mounts inside these Code Roots into
	 * a Code Bundle beside it. `resolveCodeRoots` decides, and only an Open
	 * Cloud run on an Exclusive Place ever gets any.
	 */
	codeRoots?: ReadonlyArray<PosixRoot> | undefined;
	/** File system to read and write through. */
	fileSystem: FileSystem;
	/** Loaded packages that supply the descriptors. */
	loaded: Array<LoadedPackage>;
	/** Coverage prepare pass. */
	prepareCoverage: PrepareCoverage;
	/** Selected contexts and pending entries. */
	selection: WorkspaceTestSelection;
	/** Collector for the staging spans. */
	timing: TimingCollector;
	/** Workspace root directory. */
	workspaceRoot: string;
}

/**
 * Instruments the packages that opted into coverage, stages every live
 * project's `jest.config` stub, and builds the one synthesized place the whole
 * workspace run dispatches against. The coverage map rides back out because the
 * report layer needs each package's manifest once the results land.
 *
 * Each phase times itself, and the caller opens the dispatch window only after
 * this returns — exactly as multi opens its window after its own staging. See
 * `PreDispatchTiming` for what the two halves mean and why they are measured
 * here rather than left to the residual.
 * @param options - Cache directory, packages, selection and seams.
 * @returns The place, its coverage map and the staging times.
 * @rejects When the rojo build fails.
 */
export async function stageWorkspacePlaceAsync({
	cacheDirectory,
	childProcess,
	codeRoots,
	fileSystem,
	loaded,
	prepareCoverage,
	selection,
	timing,
	workspaceRoot,
}: StageWorkspacePlaceOptions): Promise<StagedWorkspacePlace> {
	const { elapsedMs: coverageMs, value: coverageByPackage } = prepareWorkspaceCoverageMap({
		contexts: selection.filteredContexts,
		fileSystem,
		loaded,
		pending: selection.pending,
		prepareCoverage,
		timing,
		workspaceRoot,
	});

	const { elapsedMs: stubsMs, value: descriptors } = stageWorkspaceStubs({
		contexts: selection.filteredContexts,
		coverageByPackage,
		fileSystem,
		pending: selection.pending,
		timing,
	});
	const placeFile = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);
	const { codeBundle, elapsedMs } = await buildWorkspacePlaceAsync({
		cacheDirectory,
		childProcess,
		codeRoots,
		coverageByPackage,
		descriptors,
		fileSystem,
		placeFile,
		timing,
	});

	return { codeBundle, coverageByPackage, coverageMs, placeFile, stagingMs: stubsMs + elapsedMs };
}

/**
 * Workspace always synthesizes its own place, so unlike multi's coverage path
 * there is no upstream gate to defer to: a re-run with nothing edited would
 * otherwise rebuild it from scratch.
 * @param cacheDirectory - Directory the reuse caches live in.
 * @param coverage - Coverage of the instrumented packages.
 * @returns The options that key place reuse.
 */
function placeReuseOptions(
	cacheDirectory: string,
	coverage: Array<WorkspacePackageCoverage>,
): PlaceReuseOptions {
	return {
		cacheFile: path.join(cacheDirectory, PLACE_REUSE_FILE),
		digestCacheFile: path.join(cacheDirectory, INPUT_DIGEST_FILE),
		manifests: coverage.map((entry) => entry.manifest),
		// Relative: the hash resolves each root against the project directory,
		// the frame every other path in the key is expressed in, and
		// `shadowDir` is absolute.
		shadowRoots: coverage.flatMap((entry) => {
			// Spine copies included: they are what a demoted mount serves, so a
			// change there changes the place.
			return [...entry.coverageRoots, ...entry.coverageSpine].map((root) => {
				return path.relative(cacheDirectory, root.shadowDir);
			});
		}),
	};
}

/**
 * Builds the shared place and reports how long the rojo build took.
 * @param options - Place inputs and build seams.
 * @param options.cacheDirectory - Directory the place and its caches live in.
 * @param options.childProcess - Runner that spawns the rojo build.
 * @param options.codeRoots - Code Roots to split into a Code Bundle, if any.
 * @param options.coverageByPackage - Coverage per instrumented package.
 * @param options.descriptors - Package descriptors to synthesize.
 * @param options.fileSystem - File system to read and write through.
 * @param options.placeFile - Path to write the place to.
 * @param options.timing - Collector for the `rojoBuild` span.
 * @returns The Code Bundle, if split, and the build time.
 * @rejects When the rojo build fails.
 */
async function buildWorkspacePlaceAsync({
	cacheDirectory,
	childProcess,
	codeRoots,
	coverageByPackage,
	descriptors,
	fileSystem,
	placeFile,
	timing,
}: {
	cacheDirectory: string;
	childProcess: ChildProcessRunner;
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	descriptors: Array<PackageDescriptor>;
	fileSystem: FileSystem;
	placeFile: string;
	timing: TimingCollector;
}): Promise<{ codeBundle?: CodeBundleArtifact | undefined; elapsedMs: number }> {
	const coverage = [...coverageByPackage.values()];
	const { elapsedMs, value: coveragePlace } = await timing.profileTimedAsync(
		"rojoBuild",
		async () => {
			const built = await buildPlaceAsync({
				childProcess,
				codeRoots,
				fileSystem,
				packages: descriptors,
				placeFile,
				projectFile: path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE),
				reuse: placeReuseOptions(cacheDirectory, coverage),
			});
			// Inside the span: closing it closes the stage, and a size handed
			// over after that arrives too late to reach the line the stage
			// prints.
			timing.progress.describe("build", describePlaceFile(placeFile));
			return built;
		},
	);

	// Emit only after the shared build succeeds: `buildPlaceAsync` throws on a
	// failed rojo build, so a per-package Build Manifest never points at a place
	// that isn't on disk. Every coverage package records the one shared
	// instrumented place as its coverage place.
	emitWorkspaceBuildManifests({ coveragePlace, entries: coverage, fileSystem });

	return { codeBundle: coveragePlace.codeBundle, elapsedMs };
}
