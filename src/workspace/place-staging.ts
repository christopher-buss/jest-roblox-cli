import * as path from "node:path";

import {
	emitWorkspaceBuildManifests,
	type WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import { describePlaceFile } from "../progress/stages.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import { prepareWorkspaceCoverageMap } from "./coverage-attach.ts";
import type { LoadedPackage } from "./package-loader.ts";
import { stageWorkspaceStubs } from "./stub-staging.ts";
import type { WorkspaceTestSelection } from "./test-selection.ts";

const SYNTHESIZED_PROJECT_FILE = "synthesized.project.json";
const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";
const PLACE_REUSE_FILE = "synthesized.place-cache.json";

export interface StagedWorkspacePlace {
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	/**
	 * Host time spent instrumenting the packages that opted into coverage — the
	 * phase multi reports as its coverage bake. 0 when no package opted in, so
	 * a run that collected no coverage reports no coverage time.
	 */
	coverageMs: number;
	placeFile: string;
	/**
	 * Host time spent on the rest of the staging: the stubs and the rojo build,
	 * which a run pays whether or not it collects coverage.
	 */
	stagingMs: number;
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
 */
export async function stageWorkspacePlaceAsync({
	cacheDirectory,
	loaded,
	selection,
	timing,
	workspaceRoot,
}: {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
	selection: WorkspaceTestSelection;
	timing: TimingCollector;
	workspaceRoot: string;
}): Promise<StagedWorkspacePlace> {
	const { filteredContexts: contexts, pending } = selection;
	const coverageStart = Date.now();
	const coverageByPackage = prepareWorkspaceCoverageMap({
		contexts,
		loaded,
		pending,
		timing,
		workspaceRoot,
	});
	// Claimed as coverage only when a package actually opted in: the empty
	// prepare still costs a millisecond or two, and reporting that as coverage
	// would put a coverage segment on a run that collected none. It stays
	// inside the staging window instead, rather than going unreported.
	const isCoverage = coverageByPackage.size > 0;
	const coverageMs = isCoverage ? Date.now() - coverageStart : 0;

	const stagingStart = isCoverage ? Date.now() : coverageStart;
	const descriptors = stageWorkspaceStubs({ contexts, coverageByPackage, pending, timing });
	const placeFile = await buildWorkspacePlaceAsync({
		cacheDirectory,
		coverageByPackage,
		descriptors,
		timing,
	});

	return { coverageByPackage, coverageMs, placeFile, stagingMs: Date.now() - stagingStart };
}

async function buildWorkspacePlaceAsync({
	cacheDirectory,
	coverageByPackage,
	descriptors,
	timing,
}: {
	cacheDirectory: string;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	descriptors: Array<PackageDescriptor>;
	timing: TimingCollector;
}): Promise<string> {
	const placeFile = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);
	const coverage = [...coverageByPackage.values()];
	const coveragePlace = await timing.profileAsync("rojoBuild", async () => {
		const built = await buildPlaceAsync({
			packages: descriptors,
			placeFile,
			projectFile: path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE),
			// Workspace always synthesizes its own place, so unlike multi's
			// coverage path there is no upstream gate to defer to: a re-run
			// with nothing edited would otherwise rebuild it from scratch.
			reuse: {
				cacheFile: path.join(cacheDirectory, PLACE_REUSE_FILE),
				manifests: coverage.map((entry) => entry.manifest),
				// Relative: the hash resolves each root against the project
				// directory, the frame every other path in the key is expressed
				// in, and `shadowDir` is absolute.
				shadowRoots: coverage.flatMap((entry) => {
					// Spine copies included: they are what a demoted mount
					// serves, so a change there changes the place.
					return [...entry.coverageRoots, ...entry.coverageSpine].map((root) => {
						return path.relative(cacheDirectory, root.shadowDir);
					});
				}),
			},
		});
		// Inside the span: closing it closes the stage, and a size handed over
		// after that arrives too late to reach the line the stage prints.
		timing.progress.describe("build", describePlaceFile(placeFile));
		return built;
	});

	// Emit only after the shared build succeeds: `buildPlaceAsync` throws on a
	// failed rojo build, so a per-package Build Manifest never points at a place
	// that isn't on disk. Every coverage package records the one shared
	// instrumented place as its coverage place.
	if (coverage.length > 0) {
		emitWorkspaceBuildManifests(coverage, coveragePlace);
	}

	return placeFile;
}
