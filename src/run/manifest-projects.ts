import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { BuildManifestProject } from "../coverage-pipeline/build-manifest.ts";

/**
 * Map resolved project configs to the BuildManifest's per-project records. A
 * project can mount at several DataModel paths; each becomes its own entry so
 * the kernel resolves one project-root Instance per path. `setupFiles` /
 * `setupFilesAfterEnv` are already DataModel paths by the time projects
 * resolve.
 */
export function toBuildManifestProjects(
	projects: Array<ResolvedProjectConfig>,
): Array<BuildManifestProject> {
	return projects.flatMap((project) => {
		return project.projects.map((projectDataModelPath) => {
			let manifestProject: BuildManifestProject = {
				displayName: project.displayName,
				projectDataModelPath,
				setupFiles: project.config.setupFiles ?? [],
				setupFilesAfterEnv: project.config.setupFilesAfterEnv ?? [],
				testMatch: project.testMatch,
			};
			if (project.config.jestPath !== undefined) {
				manifestProject = {
					...manifestProject,
					jestDataModelPath: project.config.jestPath,
				};
			}

			return manifestProject;
		});
	});
}
