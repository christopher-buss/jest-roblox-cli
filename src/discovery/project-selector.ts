import type { ProjectScope } from "../config/filter-projects-by-files.ts";
import { matchFilesToProjects } from "../config/filter-projects-by-files.ts";
import { assertKnownProjectNames } from "../config/projects.ts";

/** Project and file filters shared by both run layouts. */
export interface ProjectSelectorInput {
	/** Invocation directory for positional files. */
	fileBase: string;
	/** Positional files, when supplied. */
	files: ReadonlyArray<string> | undefined;
	/** Requested project display names. */
	names: ReadonlyArray<string> | undefined;
	/** Projects and their include-pattern bases. */
	scopes: ReadonlyArray<ProjectScope>;
}

/**
 * Select names before matching files, preserving scope order.
 * @param input - Project scopes and CLI filters.
 * @returns Selected scopes with absolute positional files, if filtered.
 * @throws {Error} When a name is unknown or no selected scope owns any file.
 */
export function selectProjectScopes({
	fileBase,
	files,
	names,
	scopes,
}: ProjectSelectorInput): Array<{ files: Array<string> | undefined; scope: ProjectScope }> {
	let selected = scopes;
	if (names !== undefined) {
		assertKnownProjectNames(
			[...names],
			new Set(scopes.map((scope) => scope.project.displayName)),
		);
		const wanted = new Set(names);
		selected = scopes.filter((scope) => wanted.has(scope.project.displayName));
	}

	if (files === undefined || files.length === 0) {
		return selected.map((scope) => ({ files: undefined, scope }));
	}

	return matchFilesToProjects({ fileBase, files, scopes: selected }).map(
		({ files: matched, scope }) => ({ files: matched.map((file) => file.absolute), scope }),
	);
}
