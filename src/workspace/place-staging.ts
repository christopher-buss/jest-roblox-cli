import * as path from "node:path";

import {
	emitWorkspaceBuildManifests,
	type WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import { buildPlace } from "../staging/place-builder.ts";
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
	placeFile: string;
}

/**
 * Instruments the packages that opted into coverage, stages every live
 * project's `jest.config` stub, and builds the one synthesized place the whole
 * workspace run dispatches against. The coverage map rides back out because the
 * report layer needs each package's manifest once the results land.
 */
export function stageWorkspacePlace({
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
}): StagedWorkspacePlace {
	const { filteredContexts: contexts, pending } = selection;
	const coverageByPackage = prepareWorkspaceCoverageMap({
		contexts,
		loaded,
		pending,
		timing,
		workspaceRoot,
	});
	const descriptors = stageWorkspaceStubs({ contexts, coverageByPackage, pending, timing });

	return {
		coverageByPackage,
		placeFile: buildWorkspacePlace({ cacheDirectory, coverageByPackage, descriptors, timing }),
	};
}

function buildWorkspacePlace({
	cacheDirectory,
	coverageByPackage,
	descriptors,
	timing,
}: {
	cacheDirectory: string;
	coverageByPackage: Map<string, WorkspacePackageCoverage>;
	descriptors: Array<PackageDescriptor>;
	timing: TimingCollector;
}): string {
	const placeFile = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);
	const coverage = [...coverageByPackage.values()];
	const coveragePlace = timing.profile("rojoBuild", () => {
		return buildPlace({
			packages: descriptors,
			placeFile,
			projectFile: path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE),
			// Workspace always synthesizes its own place, so unlike multi's
			// coverage path there is no upstream gate to defer to: a re-run
			// with nothing edited would otherwise rebuild it from scratch.
			reuse: {
				cacheFile: path.join(cacheDirectory, PLACE_REUSE_FILE),
				manifests: coverage.map((entry) => entry.manifest),
				// Relative: the hash joins each root onto the project directory,
				// and `shadowDir` is absolute.
				shadowRoots: coverage.flatMap((entry) => {
					return entry.coverageRoots.map((root) => {
						return path.relative(cacheDirectory, root.shadowDir);
					});
				}),
			},
		});
	});

	// Emit only after the shared build succeeds: `buildPlace` throws on a failed
	// rojo build, so a per-package Build Manifest never points at a place that
	// isn't on disk. Every coverage package records the one shared instrumented
	// place as its coverage place.
	if (coverage.length > 0) {
		emitWorkspaceBuildManifests(coverage, coveragePlace);
	}

	return placeFile;
}
