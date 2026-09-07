import picomatch from "picomatch";

import type { RojoTreeNode } from "../types/rojo.ts";
import { isString } from "../utils/is-string.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const DRIVE_LETTER = /^[A-Za-z]:/;
/**
 * The paths a project drops, as the strings rojo matches them by.
 *
 * Takes the raw object rather than a parsed project: a caller reading a rojo
 * project holds either a validated tree or the JSON it came from, and the one
 * field this reads means the same thing in both.
 */
export function readGlobIgnorePaths({
	globIgnorePaths: value,
}: JSONObject | RojoTreeNode): Array<string> {
	return Array.isArray(value) ? value.filter(isString) : [];
}

/**
 * Whether the project already drops a path, so a staging pass must not put it
 * back or carry it somewhere else. A consumer who hit a mount the engine
 * rejects worked around it by ignoring the offending file; a pass that
 * rebuilds or bundles it anyway undoes that.
 *
 * Matched with and without the drive letter, because a declared pattern is
 * written against whatever frame the consumer's project expresses its mounts
 * in, and a leading globstar has to reach either one.
 */
export function createIgnoreMatcher(
	patterns: ReadonlyArray<string>,
): (absolutePath: string) => boolean {
	// A project that drops nothing is the ordinary case, and the split asks
	// this of every file it walks — thousands per run, each otherwise paying a
	// path normalize and two picomatch calls to be told no.
	if (patterns.length === 0) {
		return neverIgnored;
	}

	const match = picomatch([...patterns], { dot: true });
	return (absolutePath: string) => {
		const normalized = normalizeWindowsPath(absolutePath);
		return match(normalized) || match(normalized.replace(DRIVE_LETTER, ""));
	};
}

/**
 * The answer for a project that drops nothing, shared so the fast path is
 * observable: two matchers over an empty list are the same function, and one
 * built from picomatch could never be.
 */
function neverIgnored(): boolean {
	return false;
}
