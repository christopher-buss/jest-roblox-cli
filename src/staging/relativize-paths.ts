import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Rewrite every `$path` in a synthesized project so it is expressed relative to
 * the directory the project file is written to.
 *
 * Rojo matches `globIgnorePaths` against each candidate path *as the project
 * expresses it*, so an absolute `$path` silently disables the ignore list for
 * that mount — even a catch-all pattern ignores nothing. Synthesis resolves
 * every `$path` to an absolute location because it has to read them off disk
 * (stub injection stats directories, coverage redirects rewrite roots);
 * emitting them relative is the last step that makes the globs mean something
 * again.
 *
 * A target on another drive has no relative form. `path.relative` returns it
 * absolute, which is exactly what gets emitted — that one mount keeps the old
 * behavior rather than failing the build.
 */
export function relativizeProjectPaths(projectJson: string, projectDirectory: string): string {
	const rewritten = rewrite(JSON.parse(projectJson), projectDirectory);
	return JSON.stringify(rewritten, undefined, 2);
}

function rewrite(value: JSONValue, projectDirectory: string): JSONValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}

	const result: Record<string, JSONValue> = {};
	for (const [key, member] of Object.entries(value)) {
		if (key === "$path" && typeof member === "string" && path.isAbsolute(member)) {
			result[key] = normalizeWindowsPath(path.relative(projectDirectory, member));
			continue;
		}

		result[key] = rewrite(member, projectDirectory);
	}

	return result;
}
