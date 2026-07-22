import { type } from "arktype";
import assert from "node:assert";

import { normalizeRawCoverage } from "../coverage-pipeline/raw-coverage.ts";
import type { PerTestCoverageEntry, RawCoverageData } from "../coverage-pipeline/types.ts";
import type { JestResult, SnapshotSummary } from "../types/jest-result.ts";

export type SnapshotWrites = Record<string, string>;

interface ParseResult {
	coverageData?: RawCoverageData;
	luauTiming?: Record<string, number>;
	perTestCoverage?: Array<PerTestCoverageEntry>;
	result: JestResult;
	setupSeconds?: number;
	snapshotWrites?: SnapshotWrites;
}

const TASK_SCRIPT_PREFIX = /^TaskScript:\d+:\s*/;

export class LuauScriptError extends Error {
	/**
	 * Jest's own process.stdout/stderr writes captured via InterceptWriteable.
	 * Used by the CLI error banner to surface synchronous exit messages
	 * (e.g. "No tests found, exiting with code 1"). Narrower than
	 * {@link gameOutput}; see CONTEXT.md for the split.
	 */
	public bannerOutput?: string;
	/**
	 * The LogService.MessageOut dump for the failed run. Propagated through
	 * the exec-error path so `--gameOutput <path>` still receives the full
	 * log when an entry's envelope decodes to a Luau-level script failure.
	 */
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

const jestEnvelopeSchema = type("Record<string, unknown>");

const perTestCoverageSchema = type({
	delta: type({ "[string]": { s: "number[]" } }),
	testCaseId: "string",
	testFilePath: "string",
}).array();

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
	const candidate = findJestJsonCandidate(output);
	if (candidate === undefined) {
		throw new Error(`No valid Jest result JSON found in output, output was:\n${output}`);
	}

	return parseParsedOutput(jestEnvelopeSchema.assert(JSON.parse(candidate)));
}

function countBraces(line: string): number {
	let count = 0;
	for (const character of line) {
		if (character === "{") {
			count++;
		} else if (character === "}") {
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

function findJestJsonCandidate(output: string): string | undefined {
	const trimmed = output.trim();
	if (trimmed.startsWith("{") && isValidJson(trimmed)) {
		return trimmed;
	}

	return extractJsonFromOutput(output);
}

const PROMISE_TRACE_HEADER = /^-- Promise\.Error\(/;
// Accept zero-or-more spaces after the second colon so we also catch
// `path:N:msg` from Luau `error(msg, 0)` calls that don't add a space.
const PROMISE_TRACE_CAUSE_LINE = /:\d+:\s*(.+)$/;

/**
 * Standalone extraction of the `_timing` field from a raw envelope entry's
 * `jestOutput`, for callers that want the Luau phase breakdown without
 * running the full `parseJestOutput` pipeline (schema validation,
 * coverage/snapshot extraction) — namely the orchestrator surfacing it into
 * the host `TimingCollector` span tree while `backend.runTests` is still on
 * the stack. Returns undefined when no JSON candidate is found; mirrors
 * `parseJestOutput`'s assumption that a found candidate always parses (its
 * source, `findJestJsonCandidate`, only ever returns pre-validated JSON).
 */
export function extractLuauTimingFromOutput(
	jestOutput: string,
): Record<string, number> | undefined {
	const candidate = findJestJsonCandidate(jestOutput);
	if (candidate === undefined) {
		return undefined;
	}

	return extractLuauTiming(jestEnvelopeSchema.assert(JSON.parse(candidate)));
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

function looksLikePromiseTrace(text: string): boolean {
	return PROMISE_TRACE_HEADER.test(text);
}

function extractCauseFromPromiseTrace(trace: string): string | undefined {
	for (const rawLine of trace.split("\n").reverse()) {
		const line = rawLine.trim();
		if (line === "") {
			continue;
		}

		const match = PROMISE_TRACE_CAUSE_LINE.exec(line);
		if (match !== null) {
			return match[1];
		}
	}

	return undefined;
}

function extractExecutionError(object: Record<string, unknown>): string {
	// Traverse nested parent chain to find root error. `typeof null === "object"`
	// in JS, so an explicit null guard is required to stop at the leaf.
	let current = object;
	while (true) {
		const { parent } = current;
		if (parent === null || typeof parent !== "object") {
			break;
		}

		current = parent as Record<string, unknown>;
	}

	const errorValue = current["error"];
	if (typeof errorValue !== "string") {
		return "Unknown error";
	}

	if (looksLikePromiseTrace(errorValue)) {
		const cause = extractCauseFromPromiseTrace(errorValue);
		if (cause !== undefined) {
			return cause;
		}
	}

	return errorValue;
}

function extractCoverageData(parsed: Record<string, unknown>): RawCoverageData | undefined {
	return normalizeRawCoverage(parsed["_coverage"]);
}

function extractPerTestCoverage(
	parsed: Record<string, unknown>,
): Array<PerTestCoverageEntry> | undefined {
	const raw = parsed["_perTestCoverage"];
	if (raw === undefined) {
		return undefined;
	}

	// A malformed envelope (our own producer drifting) drops attribution rather
	// than throwing — the coverage report and manifest still publish without it.
	const validated = perTestCoverageSchema(raw);
	if (validated instanceof type.errors) {
		return undefined;
	}

	return validated.length > 0 ? validated : undefined;
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

// Single-line Luau `<path>:<line>:` prefix (e.g.
// "Module.Path:25: Exited with code: 1"). Mirrors the Luau-side strip in
// promise-error.luau so the CLI banner's exit-code branch can match a bare
// message regardless of which producer encoded the envelope.
const PATH_LINE_PREFIX = /^[\w.@/-]+:\d+:\s*/;

function stripPathLinePrefix(message: string): string {
	if (message.includes("\n")) {
		return message;
	}

	return message.replace(PATH_LINE_PREFIX, "");
}

function stringifyError(err: unknown): string {
	if (typeof err === "string") {
		// Defense in depth: when the Luau side encodes a Promise.Error via
		// tostring() (e.g. luau/staging/entry.luau's per-pkg failure path) the
		// raw multi-frame __tostring blob lands here as a top-level err. Walk
		// to the trailing cause line so the banner shows a clean leaf, not
		// the frame dump.
		if (looksLikePromiseTrace(err)) {
			const cause = extractCauseFromPromiseTrace(err);
			if (cause !== undefined) {
				return stripPathLinePrefix(cause);
			}
		}

		return stripPathLinePrefix(err);
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
		return extractExecutionError(err);
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

function numericField(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" ? value : 0;
}

function extractSnapshotSummary(
	resultsObject: Record<string, unknown>,
): SnapshotSummary | undefined {
	const { snapshot } = resultsObject;
	if (snapshot === undefined || snapshot === null || typeof snapshot !== "object") {
		return undefined;
	}

	const source = snapshot as Record<string, unknown>;
	const summary: SnapshotSummary = {
		added: numericField(source, "added"),
		matched: numericField(source, "matched"),
		total: numericField(source, "total"),
		unmatched: numericField(source, "unmatched"),
		updated: numericField(source, "updated"),
	};

	if (typeof source["filesRemoved"] === "number") {
		summary.filesRemoved = source["filesRemoved"];
	}

	if (typeof source["unchecked"] === "number") {
		summary.unchecked = source["unchecked"];
	}

	if (typeof source["didUpdate"] === "boolean") {
		summary.didUpdate = source["didUpdate"];
	}

	return summary;
}

function parseParsedOutput(parsed: Record<string, unknown>): ParseResult {
	const coverageData = extractCoverageData(parsed);
	const luauTiming = extractLuauTiming(parsed);
	const perTestCoverage = extractPerTestCoverage(parsed);
	const setupSeconds = extractSetupSeconds(parsed);
	const snapshotWrites = extractSnapshotWrites(parsed);
	const unwrapped = unwrapResult(parsed);

	if (unwrapped["kind"] === "ExecutionError") {
		const errorMessage = extractExecutionError(unwrapped);
		throw new LuauScriptError(`Jest execution failed: ${errorMessage}`);
	}

	if (unwrapped["results"] !== undefined && typeof unwrapped["results"] === "object") {
		const resultsObject = unwrapped["results"] as Record<string, unknown>;
		const validated = validateJestResult(resultsObject);
		const snapshot = extractSnapshotSummary(resultsObject);
		return {
			coverageData,
			luauTiming,
			perTestCoverage,
			result: snapshot !== undefined ? { ...validated, snapshot } : validated,
			setupSeconds,
			snapshotWrites,
		};
	}

	const validated = validateJestResult(unwrapped);
	const snapshot = extractSnapshotSummary(unwrapped);
	return {
		coverageData,
		luauTiming,
		perTestCoverage,
		result: snapshot !== undefined ? { ...validated, snapshot } : validated,
		setupSeconds,
		snapshotWrites,
	};
}
