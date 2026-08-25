import * as fs from "node:fs";
import * as path from "node:path";

import { hashString } from "../utils/hash.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CoverageUniverseFilter } from "./coverage-universe.ts";
import { createCoverageUniverseMatcher, resolveUniverseAnchor } from "./coverage-universe.ts";
import { resolveSourcePath } from "./source-path.ts";

/**
 * The instrument-time half of the coverage universe: which compiled Luau files
 * are worth probing at all.
 *
 * Instrumentation used to cover every Luau root the rojo project mounts, and
 * the coverage globs narrowed the result afterwards, host-side. The probes for
 * everything in between still fired, and the runner still shipped their hit
 * counts home inside the task's return envelope — which Open Cloud caps at
 * 4 MiB. A place with ~290k probes spends most of that budget on files the
 * report was always going to discard.
 *
 * Deciding here instead keeps the two halves in agreement by construction: a
 * file is probed exactly when `filterCoverageUniverse` would keep it, because
 * both ask `createCoverageUniverseMatcher` about the same source path.
 */
export interface InstrumentUniverse {
	/**
	 * Stable digest of the patterns behind this universe. The incremental
	 * cache compares it against the manifest's, because narrowing the globs
	 * leaves already-instrumented shadow copies on disk that nothing else
	 * would invalidate.
	 */
	digest: string;
	/** Whether the compiled file at `luauPath` should be instrumented. */
	includes: (luauPath: string) => boolean;
}

/**
 * Build the gate for a set of coverage globs, or `undefined` when the config
 * gives nothing to narrow by — the caller then instruments the whole root, as
 * it always has.
 *
 * `ignore` alone does not make a universe. `coveragePathIgnorePatterns`
 * already drops whole roots before instrumentation, and its remaining job is a
 * report-time filter over TypeScript paths; re-deciding it per file here would
 * change what gets probed on every project that never set a coverage glob.
 */
export function createInstrumentUniverse(
	filter: CoverageUniverseFilter,
): InstrumentUniverse | undefined {
	const include = filter.include ?? [];
	if (include.length === 0) {
		return undefined;
	}

	const ignore = filter.ignore ?? [];
	const anchor = resolveUniverseAnchor(filter.rootDir);
	const isInUniverse = createCoverageUniverseMatcher(filter);

	return {
		// Sorted before hashing: the matcher ORs each list, so reordering the
		// globs cannot change which files are probed — and a digest that moved
		// anyway would spend a cold rebuild on a no-op config edit. The anchor
		// is hashed alongside them because it is half of what a glob means:
		// re-anchoring the same globs selects a different set of files.
		digest: hashString(
			JSON.stringify({ anchor, ignore: ignore.toSorted(), include: include.toSorted() }),
		),
		includes: (luauPath) => {
			const sources = readSourcePaths(luauPath);
			// An unreadable sidecar says nothing about the file's origin, and
			// the compiled path cannot match a `.ts` glob — so treating it as
			// its own source would silently drop the file from the report.
			// Probe it: a wasted probe costs bytes, a missing one fails a
			// threshold.
			return sources === undefined || sources.some(isInUniverse);
		},
	};
}

function isFileNotFound(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * The paths that decide whether a compiled file is in the universe: the
 * sources its sidecar declares, or the file itself when there is no sidecar.
 * `undefined` when a sidecar exists but yields nothing usable.
 *
 * A file with no sidecar is its own source — the same fallback
 * `mapCoverageToTypeScript` makes when it keys a map-less file on its own
 * path, which is how a hand-written Luau project reports at all.
 *
 * Every declared source counts, not just the first: a file built from more
 * than one module is in the universe if any of them is.
 */
function readSourcePaths(luauPath: string): Array<string> | undefined {
	const sourceMapPath = `${luauPath}.map`;

	let raw: string;
	try {
		raw = fs.readFileSync(sourceMapPath, "utf-8");
	} catch (err) {
		// Absent is an answer: no compile step to see through, so the file is
		// its own source. Unreadable is not — a sidecar the run cannot open is
		// a compiled file whose origin is unknown, and calling it its own
		// source would test a `.luau` path against `.ts` globs and drop it.
		return isFileNotFound(err) ? [normalizeWindowsPath(luauPath)] : undefined;
	}

	let parsed: JSONValue;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}

	const { sources } = parsed;
	if (!Array.isArray(sources)) {
		return undefined;
	}

	const sourceMapDirectory = path.posix.dirname(normalizeWindowsPath(sourceMapPath));
	const resolved = sources
		.filter((source): source is string => typeof source === "string")
		.map((source) => resolveSourcePath(source, sourceMapDirectory));

	return resolved.length > 0 ? resolved : undefined;
}
