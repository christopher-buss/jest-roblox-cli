/**
 * Compose an entry's display name from its package and project.
 * @param packageName - The owning package, if the run has packages.
 * @param project - The project inside the package.
 * @returns `package › project`, or the project alone.
 */
export function composeEntryDisplayName(packageName: string | undefined, project: string): string {
	return packageName === undefined || packageName === project
		? project
		: `${packageName} › ${project}`;
}
