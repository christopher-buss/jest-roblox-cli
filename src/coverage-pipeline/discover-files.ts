import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";

import { hashString } from "../utils/hash.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
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

/**
 * The `coverageCopyIgnorePatterns` gate, over paths relative to the compiled
 * root. One matcher answers for the whole shadow — the walks and the reconcile
 * — so a pattern cannot mean one thing on a cold run and another on a warm one.
 */
export type CopyIgnoreMatcher = (relativePath: string) => boolean;

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

export interface DiscoverRootFilesOptions {
	/** Paths the shadow never carries; absent means the whole root. */
	isCopyIgnored?: CopyIgnoreMatcher | undefined;
	/** Narrows which prod files probe; absent means all of them. */
	universe?: InstrumentUniverse | undefined;
}

/** What one walk collects, and what it refuses to descend into. */
export interface WalkFilter {
	/** Collect a file when true. Receives the entry's own name. */
	accept: (name: string) => boolean;
	/**
	 * Called for every directory the walk descends into, with its path relative
	 * to the walk root. A directory carries no file to collect, so this is the
	 * only way a caller mirroring the tree learns an empty one exists.
	 */
	onDirectory?: ((relativePath: string) => void) | undefined;
	/**
	 * Skip an entry when true — a directory takes its subtree with it.
	 * Receives the path relative to the walk root.
	 */
	skip?: CopyIgnoreMatcher | undefined;
}

/**
 * Compile `coverageCopyIgnorePatterns` into the gate every shadow pass shares.
 *
 * Anchored, unlike the `contains: true` matcher over
 * `coveragePathIgnorePatterns`: this list decides what reaches the built place,
 * where an over-match drops a file the runtime needs rather than a row from a
 * report.
 */
export function createCopyIgnoreMatcher(patterns: ReadonlyArray<string>): CopyIgnoreMatcher {
	return picomatch([...patterns]);
}

/**
 * Stable digest of a copy-ignore list, for the incremental cache to compare
 * against the manifest's.
 *
 * The same job `InstrumentUniverse.digest` does, for the same reason: adding a
 * pattern demotes a file the shadow already holds while its source hash never
 * moves, so nothing else would invalidate it. Sorted before hashing because the
 * matcher ORs the list — reordering cannot change what is ignored, and a digest
 * that moved anyway would spend a cold rebuild on a no-op config edit.
 */
export function hashCopyIgnorePatterns(patterns: ReadonlyArray<string>): string {
	return hashString(JSON.stringify([...patterns].toSorted()));
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
 * Shared directory walker. Skips node_modules and dot-prefixed directories,
 * plus anything `filter.skip` claims.
 */
export function walkLuauDirectory(
	directory: string,
	relativeTo: string,
	filter: WalkFilter,
	results: Array<string>,
): void {
	const entries = fs.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = normalizeWindowsPath(path.join(directory, entry.name));
		const relative = fullPath.slice(relativeTo.length + 1);
		if (filter.skip?.(relative) === true) {
			continue;
		}

		if (entry.isDirectory()) {
			if (isSkippedDirectory(entry.name)) {
				continue;
			}

			filter.onDirectory?.(relative);
			walkLuauDirectory(fullPath, relativeTo, filter, results);
		} else if (filter.accept(entry.name)) {
			results.push(relative);
		}
	}
}

/**
 * Fast directory walk over one root's prod .luau/.lua files, split by the
 * coverage universe. This is the single discovery pass every consumer of the
 * pipeline shares — the instrumenter parses exactly this file set.
 *
 * An ignored path lands in neither set. That is what makes the knob mean the
 * same thing for a probed file as for a mirrored one: it never reaches the
 * instrumenter, so nothing writes it into the shadow behind the copy's back.
 *
 * @param luauRoot - Root directory to walk.
 * @param options - The coverage universe and the copy-ignore gate.
 * @returns Discovered files split by instrumentability.
 */
export function discoverRootFiles(
	luauRoot: string,
	{ isCopyIgnored, universe }: DiscoverRootFilesOptions = {},
): RootFiles {
	const posixRoot = toPosixRoot(luauRoot);
	const discovered: Array<string> = [];
	walkLuauDirectory(
		posixRoot,
		posixRoot,
		{ accept: isInstrumentableFile, skip: isCopyIgnored },
		discovered,
	);

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
