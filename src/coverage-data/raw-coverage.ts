import type { RawCoverageData, RawFileCoverage } from "./coverage-types.ts";

/**
 * Normalizes a runtime coverage hit table.
 * @param coverage - Runtime hit table.
 * @returns Normalized coverage, or undefined when no file has a statement map.
 */
export function normalizeRawCoverage(coverage: JSONValue | undefined): RawCoverageData | undefined {
	if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
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
 * Extracts raw coverage from a run's result envelope.
 * @param output - Envelope JSON string, parsed envelope or bare hit table.
 * @returns Normalized coverage, or undefined when none is found.
 */
export function parseCoverageEnvelope(output: JSONValue): RawCoverageData | undefined {
	const parsed = typeof output === "string" ? parseJson(output) : output;
	if (parsed === null || typeof parsed !== "object") {
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

function parseJson(text: string): JSONValue | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
