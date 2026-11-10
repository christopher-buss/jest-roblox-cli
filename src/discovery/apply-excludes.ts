import { matchesGlobPattern } from "../utils/glob.ts";

/**
 * Drop files that match any exclude glob.
 *
 * @param files - Paths to filter.
 * @param excludeGlobs - Globs whose matches are dropped.
 * @returns The files that match no exclude glob.
 */
export function applyExcludes(
	files: Array<string>,
	excludeGlobs: Array<string> | undefined,
): Array<string> {
	if (excludeGlobs === undefined || excludeGlobs.length === 0) {
		return files;
	}

	return files.filter((file) => {
		return excludeGlobs.every((pattern) => !matchesGlobPattern(file, pattern));
	});
}
