/**
 * The key of one (package, project) pair.
 *
 * File selection and output sinks must both key through this one encoder.
 * @param packageName - Name of the package that owns the project.
 * @param project - Display name of the project within that package.
 * @returns The JSON-encoded pair.
 */
export function projectKey(packageName: string, project: string): string {
	return JSON.stringify([packageName, project]);
}
