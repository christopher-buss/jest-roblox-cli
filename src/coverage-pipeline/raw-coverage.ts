import type { RawCoverageData, RawFileCoverage } from "./types.ts";

/**
 * Normalize a raw coverage table into typed {@link RawCoverageData}. The input
 * is the per-file hit table the coverage probes accumulate at runtime — the
 * `_G.__jest_roblox_cov` global, or the `runner.coverage` field of a run
 * envelope —
 * keyed by the stable per-file join key (`fileKey`). Luau serializes the
 * `s`/`f` counters as 1-based arrays and `b` as an array of arrays; this
 * canonicalizes them to string-keyed records while leaving the fileKey
 * verbatim (it is the byte-identical join key the static maps are also keyed
 * to). Returns `undefined` when the input is not an object or carries no file
 * with a statement map.
 */
export function normalizeRawCoverage(coverage: JSONValue | undefined): RawCoverageData | undefined {
	// The table is keyed by fileKey, so a JSON array is never a coverage table
	// — an empty Luau table serializes as `[]` and carries no file either way.
	if (
		coverage === undefined ||
		coverage === null ||
		typeof coverage !== "object" ||
		Array.isArray(coverage)
	) {
		return undefined;
	}

	const record: RawCoverageData = {};
	for (const [key, value] of Object.entries(coverage)) {
		const file = normalizeFileEntry(value);
		if (file !== undefined) {
			record[key] = file;
		}
	}

	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Extract raw coverage from a completed run's result envelope — the companion
 * seam for a run this CLI did not launch. Accepts the plugin's `jestOutput` (a
 * JSON string or an already-parsed object), or the bare `_G.__jest_roblox_cov`
 * table read straight off the run. When an object carries a `runner.coverage`
 * field it is used; otherwise the object is treated as the hit table itself.
 * Returns `undefined` for malformed JSON or an envelope with no coverage.
 *
 * A multi-project result (`{ entries: [{ jestOutput }, …] }`) carries one
 * envelope per project; parse each `entries[i].jestOutput` and combine with
 * `mergeRawCoverage`.
 */
export function parseCoverageEnvelope(output: JSONValue): RawCoverageData | undefined {
	const parsed = typeof output === "string" ? parseJson(output) : output;
	if (parsed === null || parsed === undefined || typeof parsed !== "object") {
		return undefined;
	}

	const runner = "runner" in parsed ? parsed["runner"] : undefined;
	if (runner !== null && typeof runner === "object" && "coverage" in runner) {
		return normalizeRawCoverage(runner["coverage"]);
	}

	return normalizeRawCoverage(parsed);
}

function coerceCount(value: JSONValue): number {
	return typeof value === "number" ? value : 0;
}

function normalizeHitCounts(data: JSONValue): RawFileCoverage["s"] {
	if (Array.isArray(data)) {
		const result: Record<string, number> = {};
		for (const [index, element] of data.entries()) {
			result[String(index + 1)] = coerceCount(element);
		}

		return result;
	}

	// An already-keyed object (a re-read table). Coerce values the same way as
	// the array path so a non-numeric payload can't slip through mistyped.
	if (typeof data === "object" && data !== null) {
		const result: Record<string, number> = {};
		for (const [key, value] of Object.entries(data)) {
			result[key] = coerceCount(value);
		}

		return result;
	}

	return {};
}

function coerceArms(value: JSONValue): Array<number> {
	return Array.isArray(value) ? value.map(coerceCount) : [];
}

/**
 * Normalize branch hit counts from Luau's nested array format. Luau serializes
 * `__cov_b` as an array of arrays: `[[0,0,0], [0,0]]`. Convert the outer array
 * to a string-keyed Record with 1-based keys, coercing each arm.
 */
function normalizeBranchCounts(data: JSONValue): NonNullable<RawFileCoverage["b"]> {
	if (Array.isArray(data)) {
		const result: Record<string, Array<number>> = {};
		for (const [index, inner] of data.entries()) {
			result[String(index + 1)] = coerceArms(inner);
		}

		return result;
	}

	if (typeof data === "object" && data !== null) {
		const result: Record<string, Array<number>> = {};
		for (const [key, value] of Object.entries(data)) {
			result[key] = coerceArms(value);
		}

		return result;
	}

	return {};
}

/**
 * Convert one file's counter table. Returns `undefined` for an entry with no
 * statement map — a JSON array carries no named counters, so it is skipped for
 * the same reason.
 */
function normalizeFileEntry(value: JSONValue): RawFileCoverage | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const statements = value["s"];
	if (statements === undefined) {
		return undefined;
	}

	const file: RawFileCoverage = { s: normalizeHitCounts(statements) };
	const functions = value["f"];
	if (functions !== undefined) {
		file.f = normalizeHitCounts(functions);
	}

	const branches = value["b"];
	if (branches !== undefined) {
		file.b = normalizeBranchCounts(branches);
	}

	return file;
}

/** Returns `undefined` for malformed JSON rather than throwing. */
function parseJson(text: string): JSONValue | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
