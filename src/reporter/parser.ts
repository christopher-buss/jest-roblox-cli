import { type } from "arktype";
import assert from "node:assert";

import type { RawCoverageData } from "../coverage/types.ts";
import type { JestResult } from "../types/jest-result.ts";

export type SnapshotWrites = Record<string, string>;

export interface ParseResult {
	coverageData?: RawCoverageData;
	luauTiming?: Record<string, number>;
	result: JestResult;
	setupSeconds?: number;
	snapshotWrites?: SnapshotWrites;
}

const TASK_SCRIPT_PREFIX = /^TaskScript:\d+:\s*/;

export class LuauScriptError extends Error {
	public gameOutput?: string;

	constructor(rawMessage: string) {
		super(rawMessage.replace(TASK_SCRIPT_PREFIX, ""));
	}
}

const jestResultSchema = type({
	numFailedTests: "number",
	numPassedTests: "number",
	numPendingTests: "number",
	numTotalTests: "number",
	startTime: "number",
	success: "boolean",
	testResults: "object[]",
});

export function extractJsonFromOutput(output: string): string | undefined {
	const lines = output.split("\n");
	let braceCount = 0;
	let collecting = false;
	const jsonLines: Array<string> = [];

	for (const line of lines) {
		if (!collecting && line.trim().startsWith("{")) {
			collecting = true;
			braceCount = 0;
			jsonLines.length = 0;
		}

		if (!collecting) {
			continue;
		}

		jsonLines.push(line);
		braceCount += countBraces(line);

		if (braceCount !== 0) {
			continue;
		}

		const candidate = jsonLines.join("\n").trim();
		if (isValidJson(candidate)) {
			return candidate;
		}

		collecting = false;
	}

	return undefined;
}

export function parseJestOutput(output: string): ParseResult {
	const trimmed = output.trim();

	if (trimmed.startsWith("{")) {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const coverageData = extractCoverageData(parsed);
		const luauTiming = extractLuauTiming(parsed);
		const setupSeconds = extractSetupSeconds(parsed);
		const snapshotWrites = extractSnapshotWrites(parsed);
		const unwrapped = unwrapResult(parsed);

		// Check for Jest execution error (Promise rejection)
		if (unwrapped["kind"] === "ExecutionError") {
			const errorMessage = extractExecutionError(unwrapped);
			throw new Error(`Jest execution failed: ${errorMessage}`);
		}

		// Jest returns { globalConfig, results } - extract results
		if (unwrapped["results"] !== undefined && typeof unwrapped["results"] === "object") {
			return {
				coverageData,
				luauTiming,
				result: validateJestResult(unwrapped["results"]),
				setupSeconds,
				snapshotWrites,
			};
		}

		try {
			return {
				coverageData,
				luauTiming,
				result: validateJestResult(unwrapped),
				setupSeconds,
				snapshotWrites,
			};
		} catch {
			// Fall through to extract
		}
	}

	const jsonString = extractJsonFromOutput(output);
	if (jsonString === undefined) {
		throw new Error(`No valid Jest result JSON found in output, output was:\n${output}`);
	}

	// _coverage lives in the top-level envelope (startsWith("{") branch).
	// This fallback extracts embedded JSON from mixed stdout — no coverage.
	return { result: validateJestResult(JSON.parse(jsonString)) };
}

function countBraces(line: string): number {
	let count = 0;
	for (const character of line) {
		if (character === "{") {
			count++;
		}

		if (character === "}") {
			count--;
		}
	}

	return count;
}

function isValidJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function extractExecutionError(object: Record<string, unknown>): string {
	// Traverse nested parent chain to find root error
	let current = object;
	while (current["parent"] !== undefined && typeof current["parent"] === "object") {
		current = current["parent"] as Record<string, unknown>;
	}

	return typeof current["error"] === "string" ? current["error"] : "Unknown error";
}

function extractLuauTiming(parsed: Record<string, unknown>): Record<string, number> | undefined {
	const timing = parsed["_timing"];
	if (timing === undefined || timing === null || typeof timing !== "object") {
		return undefined;
	}

	const record: Record<string, number> = {};
	for (const [key, value] of Object.entries(timing)) {
		if (typeof value === "number") {
			record[key] = value;
		}
	}

	return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Luau 1-based integer-keyed tables serialize as JSON arrays.
 * Convert arrays to string-keyed Records with 1-based keys to match cov-map format.
 */
function normalizeHitCounts(data: unknown): Record<string, number> {
	if (Array.isArray(data)) {
		const result: Record<string, number> = {};
		let index = 0;
		for (const element of data) {
			result[String(index + 1)] = typeof element === "number" ? element : 0;
			index++;
		}

		return result;
	}

	if (typeof data === "object" && data !== null) {
		return data as Record<string, number>;
	}

	return {};
}

/**
 * Normalize branch hit counts from Luau's nested array format.
 * Luau serializes `__cov_b` as an array of arrays: `[[0,0,0], [0,0]]`.
 * Convert outer array to string-keyed Record with 1-based keys,
 * keeping inner arrays as-is.
 */
function normalizeBranchCounts(data: unknown): Record<string, Array<number>> {
	if (Array.isArray(data)) {
		const result: Record<string, Array<number>> = {};
		let index = 0;
		for (const inner of data) {
			if (Array.isArray(inner)) {
				result[String(index + 1)] = inner.map((value) =>
					typeof value === "number" ? value : 0,
				);
			} else {
				result[String(index + 1)] = [];
			}

			index++;
		}

		return result;
	}

	if (typeof data === "object" && data !== null) {
		return data as Record<string, Array<number>>;
	}

	return {};
}

function extractCoverageData(parsed: Record<string, unknown>): RawCoverageData | undefined {
	const coverage = parsed["_coverage"];
	if (coverage === undefined || coverage === null || typeof coverage !== "object") {
		return undefined;
	}

	const record: RawCoverageData = {};
	for (const [key, value] of Object.entries(coverage)) {
		if (typeof value === "object" && value !== null && "s" in value) {
			const raw = value as { b?: unknown; f?: unknown; s: unknown };
			record[key] = {
				b: raw.b !== undefined ? normalizeBranchCounts(raw.b) : undefined,
				f: raw.f !== undefined ? normalizeHitCounts(raw.f) : undefined,
				s: normalizeHitCounts(raw.s),
			};
		}
	}

	return Object.keys(record).length > 0 ? record : undefined;
}

function extractSnapshotWrites(parsed: Record<string, unknown>): SnapshotWrites | undefined {
	const writes = parsed["_snapshotWrites"];
	if (writes === undefined || writes === null || typeof writes !== "object") {
		return undefined;
	}

	const record: SnapshotWrites = {};
	for (const [key, value] of Object.entries(writes)) {
		if (typeof value === "string") {
			record[key] = value;
		}
	}

	return Object.keys(record).length > 0 ? record : undefined;
}

function stringifyError(err: unknown): string {
	if (typeof err === "string") {
		return err;
	}

	if (
		typeof err === "object" &&
		err !== null &&
		"message" in err &&
		typeof err.message === "string"
	) {
		return err.message;
	}

	if (
		typeof err === "object" &&
		err !== null &&
		"kind" in err &&
		(err as Record<string, unknown>)["kind"] === "ExecutionError"
	) {
		return extractExecutionError(err as Record<string, unknown>);
	}

	const serialized = JSON.stringify(err);
	assert(serialized !== undefined, "JSON-parsed values are always serializable");
	return serialized;
}

function unwrapResult(parsed: Record<string, unknown>): Record<string, unknown> {
	if ("err" in parsed && parsed["success"] === false) {
		throw new LuauScriptError(stringifyError(parsed["err"]));
	}

	if ("value" in parsed && parsed["success"] === true) {
		return parsed["value"] as Record<string, unknown>;
	}

	return parsed;
}

function validateJestResult(value: unknown): JestResult {
	const result = jestResultSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Invalid Jest result: ${result.summary}`);
	}

	return result as JestResult;
}

function extractSetupSeconds(parsed: Record<string, unknown>): number | undefined {
	const setup = parsed["_setup"];
	if (typeof setup !== "number") {
		return undefined;
	}

	return setup;
}
