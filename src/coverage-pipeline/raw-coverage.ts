import type { RawCoverageData, RawFileCoverage } from "./types.ts";

/**
 * Normalize a raw coverage table into typed {@link RawCoverageData}. The input
 * is the per-file hit table the coverage probes accumulate at runtime — the
 * `_G.__jest_roblox_cov` global, or the `_coverage` field of a run envelope —
 * keyed by the stable per-file join key (`fileKey`). Luau serializes the
 * `s`/`f` counters as 1-based arrays and `b` as an array of arrays; this
 * canonicalizes them to string-keyed records while leaving the fileKey verbatim
 * (it is the byte-identical join key the static maps are also keyed to). Returns
 * `undefined` when the input is not an object or carries no file with a
 * statement map.
 */
export function normalizeRawCoverage(coverage: unknown): RawCoverageData | undefined {
	if (coverage === undefined || coverage === null || typeof coverage !== "object") {
		return undefined;
	}

	const record: RawCoverageData = {};
	for (const [key, value] of Object.entries(coverage)) {
		if (typeof value !== "object" || value === null || !("s" in value)) {
			continue;
		}

		const raw = value as { b?: unknown; f?: unknown; s: unknown };
		const file: RawFileCoverage = { s: normalizeHitCounts(raw.s) };
		if (raw.f !== undefined) {
			file.f = normalizeHitCounts(raw.f);
		}

		if (raw.b !== undefined) {
			file.b = normalizeBranchCounts(raw.b);
		}

		record[key] = file;
	}

	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Extract raw coverage from a completed run's result envelope — the companion
 * seam for a run this CLI did not launch. Accepts the plugin's `jestOutput`
 * (a JSON string or an already-parsed object), or the bare `_G.__jest_roblox_cov`
 * table read straight off the run. When an object carries a `_coverage` field it
 * is used; otherwise the object is treated as the hit table itself. Returns
 * `undefined` for malformed JSON or an envelope with no coverage.
 *
 * A multi-project result (`{ entries: [{ jestOutput }, …] }`) carries one
 * envelope per project; parse each `entries[i].jestOutput` and combine with
 * `mergeRawCoverage`.
 */
export function parseCoverageEnvelope(output: unknown): RawCoverageData | undefined {
	let parsed: unknown = output;
	if (typeof output === "string") {
		try {
			parsed = JSON.parse(output);
		} catch {
			return undefined;
		}
	}

	if (parsed === null || typeof parsed !== "object") {
		return undefined;
	}

	const coverage = "_coverage" in parsed ? parsed._coverage : parsed;
	return normalizeRawCoverage(coverage);
}

function coerceCount(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function normalizeHitCounts(data: unknown): Record<string, number> {
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

function coerceArms(value: unknown): Array<number> {
	return Array.isArray(value) ? value.map(coerceCount) : [];
}

/**
 * Normalize branch hit counts from Luau's nested array format. Luau serializes
 * `__cov_b` as an array of arrays: `[[0,0,0], [0,0]]`. Convert the outer array
 * to a string-keyed Record with 1-based keys, coercing each arm.
 */
function normalizeBranchCounts(data: unknown): Record<string, Array<number>> {
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
