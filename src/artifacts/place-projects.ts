import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { RunEntryOptions } from "../run.ts";

/**
 * Resolve the project set a place's `jest.config` stubs come from, mirroring
 * `runSingleOrMulti` dispatch: an explicit `projects:` config resolves through
 * `resolveAllProjects`; a bare config collapses to the single implicit project
 * derived from its luau roots. Both callers build a place that runs runtime
 * tests — the coverage place instrumented, the Clean Place not — so type-only
 * configs are irrelevant here.
 *
 * @param config - The run's merged config.
 * @param options - Run dispatch, filesystem and seams.
 * @param options.dispatch - Run paths that load the rojo tree and build the
 *   implicit project.
 * @param options.fileSystem - Where the projects are read from.
 * @param options.seams - Host seams that resolve declared projects.
 * @returns The projects whose stubs the place mounts.
 */
export async function resolveProjectsAsync(
	config: ResolvedConfig,
	{ dispatch, fileSystem, seams }: Required<RunEntryOptions>,
): Promise<Array<ResolvedProjectConfig>> {
	const rojoTree = dispatch.loadRojoTree(config, fileSystem);
	const rawProjects = config.projects;
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return seams.resolveAllProjects({
			cwd: config.rootDir,
			entries: rawProjects,
			fileSystem,
			rojoTree,
			rootConfig: config,
			tsconfigReader: seams.tsconfigReader,
		});
	}

	return [
		dispatch.buildImplicitProject({
			config,
			fileSystem,
			rojoTree,
			tsconfigReader: seams.tsconfigReader,
		}),
	];
}
