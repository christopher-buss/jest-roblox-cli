import * as path from "node:path";

import type { RunProgress } from "../progress/run-progress.ts";
import type { StagedInputs } from "../run/pipeline.ts";
import {
	emitWorkspaceBuildManifests,
	type WorkspacePackageCoverage,
} from "../shadow/workspace-prepare.ts";
import type { PlaceReuseOptions } from "../staging/place-builder.ts";
import { buildStagedPlaceAsync } from "../staging/staged-place.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PrepareCoverage } from "./coverage-attach.ts";
import { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";
import type { LoadedPackage } from "./package-loader.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";
import type { WorkspaceTestSelection } from "./test-selection.ts";

const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";

/** The staged place and what its staging cost. */
export interface StagedWorkspacePlace {
	/** Coverage per instrumented package, for the report layer. */
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	/** Host time spent instrumenting coverage packages. */
	coverageMs: number;
	/** Path of the synthesized place file. */
	placeFile: string;
	/** Host time spent on the stubs and the rojo build. */
	stagingMs: number;
}

/** What one workspace run's staging reads, and where it writes. */
export interface StageWorkspacePlaceOptions {
	/** Directory the place and its caches are written to. */
	cacheDirectory: string;
	/** Runner that spawns the rojo build. */
	childProcess: ChildProcessRunner;
	/** File system to read and write through. */
	fileSystem: FileSystem;
	/** Loaded packages that supply the descriptors. */
	loaded: Array<LoadedPackage>;
	/** Coverage prepare pass. */
	prepareCoverage: PrepareCoverage;
	/** Stage reporter the place build describes the place to. */
	progress: RunProgress;
	/** Selected contexts and pending entries. */
	selection: WorkspaceTestSelection;
	/** Collector for the staging spans. */
	timing: TimingCollector;
}

/**
 * The synthesized place a workspace run builds under its cache.
 * @param cacheDirectory - Workspace cache directory.
 * @returns The place file path.
 */
export function synthesizedPlaceFile(cacheDirectory: string): string {
	return path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);
}

/**
 * Instrument coverage, stage the stubs and build the shared place.
 * @param options - Cache directory, packages, selection and seams.
 * @returns The place, its coverage map and the staging times.
 * @rejects When the rojo build fails.
 */
export async function stageWorkspacePlaceAsync(
	options: StageWorkspacePlaceOptions,
): Promise<StagedInputs & StagedWorkspacePlace> {
	const { cacheDirectory, fileSystem, loaded, prepareCoverage, selection, timing } = options;
	const { elapsedMs: coverageMs, value: coverageByPackage } = prepareWorkspaceCoverageMap({
		cacheDirectory,
		contexts: selection.filteredContexts,
		fileSystem,
		loaded,
		pending: selection.pending,
		prepareCoverage,
		timing,
	});
	const { placeFile, stagingMs } = await stageStubsAndBuildAsync({
		...options,
		coverageByPackage,
	});

	return {
		collectsCoverage: coverageByPackage.size > 0,
		coverageByPackage,
		coverageMs,
		placeFile,
		stagingMs,
	};
}

function placeReuseOptions(
	cacheDirectory: string,
	coverage: Array<WorkspacePackageCoverage>,
): Pick<PlaceReuseOptions, "manifests" | "shadowRoots"> {
	return {
		manifests: coverage.map((entry) => entry.manifest),
		// Relative: the reuse hash resolves roots against the project directory.
		shadowRoots: coverage.flatMap((entry) => {
			return [...entry.coverageRoots, ...entry.coverageSpine].map((root) => {
				return path.relative(cacheDirectory, root.shadowDir);
			});
		}),
	};
}

async function stageStubsAndBuildAsync({
	cacheDirectory,
	childProcess,
	coverageByPackage,
	fileSystem,
	progress,
	selection,
	timing,
}: StageWorkspacePlaceOptions & {
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
}): Promise<{ placeFile: string; stagingMs: number }> {
	const { elapsedMs: stubsMs, value: descriptors } = stageWorkspaceStubs({
		contexts: selection.filteredContexts,
		coverageByPackage,
		fileSystem,
		pending: selection.pending,
		timing,
	});
	const placeFile = synthesizedPlaceFile(cacheDirectory);
	const coverage = [...coverageByPackage.values()];
	const built = await buildStagedPlaceAsync({
		cacheDirectory,
		childProcess,
		fileSystem,
		packages: descriptors,
		placeFile,
		progress,
		reuse: placeReuseOptions(cacheDirectory, coverage),
		timing,
	});

	// Emit only after the build succeeds, so no manifest names a missing place.
	emitWorkspaceBuildManifests({
		coveragePlace: built.artifact,
		entries: coverage,
		fileSystem,
		rebuilt: built.rebuilt,
	});

	return { placeFile, stagingMs: stubsMs + built.elapsedMs };
}
