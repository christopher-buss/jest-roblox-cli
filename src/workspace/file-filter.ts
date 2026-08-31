import assert from "node:assert";

import type { ProjectScope, ProjectScopeMatch } from "../config/filter-projects-by-files.ts";
import { matchFilesToProjects } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { PackageContext } from "./project-contexts.ts";
import { projectKey } from "./project-key.ts";

export interface WorkspaceFileSelection {
	/**
	 * The contexts that survived, each narrowed to the projects that matched.
	 */
	contexts: Array<PackageContext>;
	/**
	 * Absolute paths of the files each surviving project owns, keyed by {@link
	 * projectKey}. Empty when the run named no files, which is what tells
	 * discovery to glob as usual.
	 */
	filesByProject: ReadonlyMap<string, Array<string>>;
}

export interface WorkspaceFileFilter {
	contexts: Array<PackageContext>;
	/**
	 * Base a relative positional file resolves against — the directory the CLI
	 * was invoked from, which is not any one package's.
	 */
	cwd: string;
	files: ReadonlyArray<string> | undefined;
}

/** Which package each scope came from, so the matches can be folded back. */
type PackageByProject = Map<ResolvedProjectConfig, PackageContext>;

/**
 * Narrow a workspace run to the packages and projects that own the positional
 * file arguments, pairing each surviving project with the files it owns.
 *
 * Narrows all three things a package contributes: the tree staged into the
 * synthesized place, the projects dispatched, and the files each one runs.
 * Without it a named file selects nothing — the run builds every package and
 * tests the whole workspace, silently ignoring the argument.
 *
 * Ownership itself is decided by the shared `matchFilesToProjects`, which is
 * also what multi narrows through and what rejects files no project owns. What
 * is left here is workspace-shaped: every package brings a root of its own for
 * include patterns to resolve against, and the flat match list has to be folded
 * back under the contexts it came from.
 */
export function applyFileFilter({
	contexts,
	cwd,
	files,
}: WorkspaceFileFilter): WorkspaceFileSelection {
	if (files === undefined || files.length === 0) {
		return { contexts, filesByProject: new Map() };
	}

	const packageByProject: PackageByProject = new Map();
	const scopes: Array<ProjectScope> = [];
	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			packageByProject.set(project, ctx);
			scopes.push({ project, rootDirectory: ctx.info.packageDirectory });
		}
	}

	const matches = matchFilesToProjects({ fileBase: cwd, files, scopes });
	return regroupByPackage(matches, packageByProject);
}

/**
 * Fold the flat match list back into narrowed contexts.
 *
 * Order follows the matches, which follow the scopes, which follow the original
 * context order — so a package keeps its place in the run and its projects keep
 * theirs within it.
 */
function regroupByPackage(
	matches: ReadonlyArray<ProjectScopeMatch>,
	packageByProject: PackageByProject,
): WorkspaceFileSelection {
	const filesByProject = new Map<string, Array<string>>();
	const projectsByPackage = new Map<PackageContext, Array<ResolvedProjectConfig>>();

	for (const { files, scope } of matches) {
		const ctx = packageByProject.get(scope.project);
		assert(ctx !== undefined, "every scope was built from a package context");

		filesByProject.set(
			projectKey(ctx.info.name, scope.project.displayName),
			files.map((entry) => entry.absolute),
		);

		const projects = projectsByPackage.get(ctx) ?? [];
		projects.push(scope.project);
		projectsByPackage.set(ctx, projects);
	}

	const contexts = Array.from(projectsByPackage, ([ctx, projects]) => ({ ...ctx, projects }));
	return { contexts, filesByProject };
}
