import type { RojoTreeNode } from "@isentinel/rojo-utils";

import picomatch from "picomatch";
import { isString } from "remeda";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const DRIVE_LETTER = /^[A-Za-z]:/;
/**
 * The paths a project drops, as the strings rojo matches them by.
 * @param project - Project object or tree that may hold `globIgnorePaths`.
 * @returns The string patterns, or an empty list when the field is absent.
 */
export function readGlobIgnorePaths({
	globIgnorePaths: value,
}: JSONObject | RojoTreeNode): Array<string> {
	return Array.isArray(value) ? value.filter(isString) : [];
}

/**
 * {@link readGlobIgnorePaths}, but `undefined` when none is declared.
 * @param raw - Raw project object.
 * @returns The patterns, or `undefined` when the field is not an array.
 */
export function readDeclaredGlobIgnorePaths(raw: JSONObject): Array<string> | undefined {
	return Array.isArray(raw["globIgnorePaths"]) ? readGlobIgnorePaths(raw) : undefined;
}

/**
 * The ignore list plus every user config a stub replaces.
 *
 * Entries are absolute; `relativizeProjectPaths` must rewrite them for rojo.
 * @param declared - Patterns the project declares, if any.
 * @param replacedConfigs - User config files the stubs replace.
 * @returns The merged patterns, or `declared` when nothing is replaced.
 */
export function withReplacedConfigs(
	declared: Array<string> | undefined,
	replacedConfigs: ReadonlyArray<string>,
): Array<string> | undefined {
	if (replacedConfigs.length === 0) {
		return declared;
	}

	return [...new Set([...(declared ?? []), ...replacedConfigs])];
}

/**
 * Build a predicate for paths the project ignores.
 * @param patterns - Glob patterns the project ignores.
 * @returns Predicate that is true for an ignored absolute path.
 */
export function createIgnoreMatcher(
	patterns: ReadonlyArray<string>,
): (absolutePath: string) => boolean {
	if (patterns.length === 0) {
		return neverIgnored;
	}

	const match = picomatch([...patterns], { dot: true });
	return (absolutePath: string) => {
		const normalized = normalizeWindowsPath(absolutePath);
		return match(normalized) || match(normalized.replace(DRIVE_LETTER, ""));
	};
}

function neverIgnored(): boolean {
	return false;
}
