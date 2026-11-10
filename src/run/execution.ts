import type { Backend } from "../backends/dispatch-request.ts";
import { BACKEND_CAPABILITIES } from "../backends/open-backend.ts";
import { resolvePlaceFilePath } from "../config/resolved-config.ts";
import { requireRojoProject } from "../config/rojo-project.ts";
import { buildStagedPlaceAsync } from "../staging/staged-place.ts";
import { collectStubMounts } from "../staging/stubs.ts";
import type { RunDiscovery } from "./run-plan.ts";
import type { StagedRun } from "./staging.ts";

interface PlaceBuildOutcome {
	elapsedMs: number;
}

/**
 * Build the place when the backend uses one, and report how long it took.
 * @param input - Backend, discovery and staging products.
 * @param input.backend - Backend whose capabilities decide the build.
 * @param input.discovery - Discovered projects, config, seams and profiler.
 * @param input.staged - Staging products; holds the cache root.
 * @returns The build time.
 */
export async function buildPlaceForBackendAsync({
	backend,
	discovery,
	staged,
}: {
	backend: Backend;
	discovery: RunDiscovery;
	staged: StagedRun;
}): Promise<PlaceBuildOutcome> {
	const { fileSystem, progress, projects, rootConfig, seams, timing } = discovery;
	if (rootConfig.collectCoverage || !BACKEND_CAPABILITIES[backend.kind].opensPlaceFile) {
		return { elapsedMs: 0 };
	}

	const { elapsedMs } = await buildStagedPlaceAsync({
		cacheDirectory: staged.cacheRoot,
		childProcess: seams.childProcess,
		fileSystem,
		packages: [
			{
				rojoProjectPath: requireRojoProject(rootConfig),
				stubMounts: collectStubMounts({ cacheRoot: staged.cacheRoot, projects }),
			},
		],
		placeFile: resolvePlaceFilePath(rootConfig),
		progress,
		timing,
		wrap: false,
	});
	return { elapsedMs };
}
