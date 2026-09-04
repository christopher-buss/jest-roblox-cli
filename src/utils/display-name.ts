/**
 * The one spelling of an entry's identity: the package that owns it, then the
 * project inside it.
 *
 * A project collapses to its own name when nothing distinguishes the two —
 * either the run has no packages (single-package and multi mode) or the
 * package publishes one project under its own name. Repeating the name either
 * side of the separator would read as two things where there is one.
 */
export function composeEntryDisplayName(packageName: string | undefined, project: string): string {
	return packageName === undefined || packageName === project
		? project
		: `${packageName} › ${project}`;
}
