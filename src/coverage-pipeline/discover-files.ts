import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";

/**
 * Suffixes for files that are not instrumented for coverage but still need
 * syncing to the shadow directory.
 */
const NON_INSTRUMENTED_SUFFIXES = [
	".spec.luau",
	".test.luau",
	".spec.lua",
	".test.lua",
	".snap.luau",
	".snap.lua",
] as const;

/** One root's prod `.luau`/`.lua`, split by whether it earns probes. */
export interface RootFiles {
	/**
	 * Prod files outside the coverage universe. They are mirrored into the
	 * shadow verbatim rather than probed, so the place still loads them and
	 * the report never sees hit counts it would only discard.
	 */
	excluded: Set<string>;
	/** Prod files the instrumenter will probe. */
	instrumentable: Set<string>;
}

export function isNonInstrumentedFile(filename: string): boolean {
	return NON_INSTRUMENTED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

export function isInstrumentableFile(name: string): boolean {
	return (name.endsWith(".luau") || name.endsWith(".lua")) && !isNonInstrumentedFile(name);
}

/** Directories no pipeline walk descends into. */
export function isSkippedDirectory(name: string): boolean {
	return name === "node_modules" || name.startsWith(".");
}

/**
 * Shared directory walker. Skips node_modules and dot-prefixed directories.
 * `predicate` receives the entry name and returns true to collect the file.
 */
export function walkLuauDirectory(
	directory: string,
	relativeTo: string,
	predicate: (name: string) => boolean,
	results: Array<string>,
): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = normalizeWindowsPath(path.join(directory, entry.name));
		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}

			walkLuauDirectory(fullPath, relativeTo, predicate, results);
		} else if (predicate(entry.name)) {
			const relative = fullPath.slice(relativeTo.length + 1);
			results.push(relative);
		}
	}
}

/**
 * Fast directory walk over one root's prod .luau/.lua files, split by the
 * coverage universe. This is the single discovery pass every consumer of the
 * pipeline shares — the instrumenter parses exactly this file set.
 *
 * @param luauRoot - Root directory to walk.
 * @param universe - Optional coverage universe narrowing which files probe.
 * @returns Discovered files split by instrumentability.
 */
export function discoverRootFiles(luauRoot: string, universe?: InstrumentUniverse): RootFiles {
	const posixRoot = normalizeWindowsPath(luauRoot);
	const discovered: Array<string> = [];
	walkLuauDirectory(posixRoot, posixRoot, isInstrumentableFile, discovered);

	if (universe === undefined) {
		return { excluded: new Set(), instrumentable: new Set(discovered) };
	}

	const excluded = new Set<string>();
	const instrumentable = new Set<string>();
	for (const relativePath of discovered) {
		const isInUniverse = universe.includes(`${posixRoot}/${relativePath}`);
		(isInUniverse ? instrumentable : excluded).add(relativePath);
	}

	return { excluded, instrumentable };
}
