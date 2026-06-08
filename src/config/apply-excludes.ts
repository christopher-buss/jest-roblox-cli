import { matchesGlobPattern } from "../utils/glob.ts";

/**
 * Subtract files matching any `excludeGlobs` pattern. Pure string-glob matching
 * against each file path — no filesystem access — so the caller owns the path
 * namespace: the globs must be written to match the same relative paths
 * discovery returns. Returns the input untouched when `excludeGlobs` is
 * undefined or empty.
 */
export function applyExcludes(
	files: Array<string>,
	excludeGlobs: Array<string> | undefined,
): Array<string> {
	if (excludeGlobs === undefined || excludeGlobs.length === 0) {
		return files;
	}

	return files.filter(
		(file) => !excludeGlobs.some((pattern) => matchesGlobPattern(file, pattern)),
	);
}
