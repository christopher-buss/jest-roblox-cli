import { type } from "arktype";

import type { PerTestCoverageEntry, RawCoverageData } from "../coverage-pipeline/coverage-types.ts";
import { normalizeRawCoverage } from "../coverage-pipeline/raw-coverage.ts";
import type { JestResult, SnapshotSummary } from "../types/jest-result-types.ts";
import { findJestJsonCandidate } from "./json-extraction.ts";
import { LuauScriptError } from "./luau-script-error.ts";

/** Snapshot file contents keyed by path, as the runner wrote them. */
export type SnapshotWrites = Record<string, string>;

interface ParseResult {
	coverageData?: RawCoverageData | undefined;
	luauTiming?: Record<string, number> | undefined;
	perTestCoverage?: Array<PerTestCoverageEntry> | undefined;
	result: JestResult;
	setupSeconds?: number | undefined;
	snapshotWrites?: SnapshotWrites | undefined;
}

const jestResultSchema = type({
	numFailedTests: "number",
	numPassedTests: "number",
	numPendingTests: "number",
	numTotalTests: "number",
	startTime: "number",
	success: "boolean",
	testResults: "object[]",
}).as<JestResult>();

// Every envelope reaching this schema is `JSON.parse` output, so `JSONValue` is
// the widest honest field type. Arktype has no keyword for the recursive JSON
// union, hence the brand.
const jsonValueSchema = type("unknown").as<JSONValue>();

const jestEnvelopeSchema = type({
	"err?": jsonValueSchema,
	"error?": "unknown",
	"kind?": "unknown",
	"parent?": "unknown",
	"results?": "unknown",
	// Everything the Luau runner adds beside Jest's own result. Typed
	// `unknown` here so a malformed block degrades to "no extras" in
	// `runnerFields` rather than failing the whole envelope assertion.
	"runner?": "unknown",
	"snapshot?": "unknown",
	"success?": "unknown",
	"value?": "unknown",
});

type JestEnvelope = typeof jestEnvelopeSchema.infer;

const runnerFieldsSchema = type({
	"abandon?": "unknown",
	"captureInstalled?": "unknown",
	"coverage?": jsonValueSchema,
	"perTestCoverage?": "unknown",
	"phase?": "unknown",
	"setup?": "unknown",
	"snapshotWrites?": "unknown",
	"timing?": "unknown",
});

type RunnerFields = typeof runnerFieldsSchema.infer;

const NO_RUNNER_FIELDS: RunnerFields = {};

function runnerFields(parsed: JestEnvelope): RunnerFields {
	const fields = runnerFieldsSchema(parsed.runner);
	return fields instanceof type.errors ? NO_RUNNER_FIELDS : fields;
}

const unknownRecordSchema = type({ "[string]": "unknown" });

// A field the runner omits means zero; a field it emits with the wrong type
// means the block is malformed, and `extractSnapshotSummary` reports no summary
// rather than one whose counts are inventions.
const snapshotSummaryInputSchema = type({
	"added?": "number",
	"didUpdate?": "boolean",
	"filesRemoved?": "number",
	"matched?": "number",
	"total?": "number",
	"unchecked?": "number",
	"unmatched?": "number",
	"updated?": "number",
});

const perTestCoverageSchema = type({
	delta: type({ "[string]": { s: "number[]" } }),
	testCaseId: "string",
	testFilePath: "string",
}).array();
/**
 * Parse the Jest result envelope out of raw runner output.
 *
 * @param output - Raw runner output.
 * @returns The Jest result with coverage, timing and snapshot extras.
 * @throws {Error} When the output holds no Jest result JSON.
 */
export function parseJestOutput(output: string): ParseResult {
	const candidate = findJestJsonCandidate(output);
	if (candidate === undefined) {
		throw new Error(`No valid Jest result JSON found in output, output was:\n${output}`);
	}

	return parseParsedOutput(jestEnvelopeSchema.assert(JSON.parse(candidate)));
}

const PROMISE_TRACE_HEADER = /^-- Promise\.Error\(/;
// Accept zero-or-more spaces after the second colon so we also catch
// `path:N:msg` from Luau `error(msg, 0)` calls that don't add a space.
const PROMISE_TRACE_CAUSE_LINE = /:\d+:\s*(\S.*)$/;

/**
 * Standalone extraction of the `runner.timing` field from a raw envelope
 * entry's `jestOutput`, for callers that want the Luau phase breakdown
 * without running the full `parseJestOutput` pipeline (schema validation,
 * coverage/snapshot extraction) — namely the orchestrator surfacing it into
 * the host `TimingCollector` span tree while `backend.runTests` is still on
 * the stack. Returns undefined when no JSON candidate is found; mirrors
 * `parseJestOutput`'s assumption that a found candidate always parses (its
 * source, `findJestJsonCandidate`, only ever returns pre-validated JSON).
 *
 * @param jestOutput - Raw `jestOutput` of an envelope entry.
 * @returns Luau phase durations, or `undefined` when absent.
 */
export function extractLuauTimingFromOutput(
	jestOutput: string,
): Record<string, number> | undefined {
	const candidate = findJestJsonCandidate(jestOutput);
	if (candidate === undefined) {
		return undefined;
	}

	return extractLuauTiming(runnerFields(jestEnvelopeSchema.assert(JSON.parse(candidate))));
}

function extractLuauTiming(runner: RunnerFields): Record<string, number> | undefined {
	const timing = unknownRecordSchema(runner.timing);
	if (timing instanceof type.errors) {
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
		const match = PROMISE_TRACE_CAUSE_LINE.exec(line);
		if (match !== null) {
			return match[1];
		}
	}

	return undefined;
}

function extractExecutionError(object: JestEnvelope): string {
	// Traverse nested parent chain to find root error, stopping at the leaf.
	let current = object;
	while (true) {
		const parent = jestEnvelopeSchema(current.parent);
		if (parent instanceof type.errors) {
			break;
		}

		current = parent;
	}

	const errorValue = current.error;
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

function extractCoverageData(runner: RunnerFields): RawCoverageData | undefined {
	return normalizeRawCoverage(runner.coverage);
}

function extractPerTestCoverage(runner: RunnerFields): Array<PerTestCoverageEntry> | undefined {
	// A malformed envelope (our own producer drifting) drops attribution rather
	// than throwing — the coverage report and manifest still publish without it.
	const validated = perTestCoverageSchema(runner.perTestCoverage);
	if (validated instanceof type.errors) {
		return undefined;
	}

	return validated.length > 0 ? validated : undefined;
}

function extractSnapshotWrites(runner: RunnerFields): SnapshotWrites | undefined {
	const writes = unknownRecordSchema(runner.snapshotWrites);
	if (writes instanceof type.errors) {
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

function stringifyError(err: JSONValue): string {
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
		typeof err["message"] === "string"
	) {
		return err["message"];
	}

	if (
		typeof err === "object" &&
		err !== null &&
		"kind" in err &&
		err["kind"] === "ExecutionError"
	) {
		return extractExecutionError(jestEnvelopeSchema.assert(err));
	}

	return JSON.stringify(err);
}

function unwrapResult(parsed: JestEnvelope, runner: RunnerFields): JestEnvelope {
	if (parsed.err !== undefined && parsed.success === false) {
		const error = new LuauScriptError(stringifyError(parsed.err));
		// Read off the same `runner` block every other dimension comes from,
		// so a runner that gives up on a run says so through the shared result
		// seam rather than through a field of its own on the envelope entry.
		error.timedOut = runner.abandon === "timeout" ? true : undefined;
		error.phase =
			typeof runner.phase === "string" && runner.phase !== "" ? runner.phase : undefined;
		error.captureInstalled =
			typeof runner.captureInstalled === "boolean" ? runner.captureInstalled : undefined;
		throw error;
	}

	if (parsed.value !== undefined && parsed.success === true) {
		return jestEnvelopeSchema.assert(parsed.value);
	}

	return parsed;
}

function validateJestResult(value: unknown): JestResult {
	const result = jestResultSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Invalid Jest result: ${result.summary}`);
	}

	return result;
}

function extractSetupSeconds({ setup }: RunnerFields): number | undefined {
	if (typeof setup !== "number") {
		return undefined;
	}

	return setup;
}

function extractSnapshotSummary(source: JestResult): SnapshotSummary | undefined {
	const envelope = jestEnvelopeSchema.assert(source);
	const snapshot = snapshotSummaryInputSchema(envelope.snapshot);
	if (snapshot instanceof type.errors) {
		return undefined;
	}

	const summary: SnapshotSummary = {
		added: snapshot.added ?? 0,
		matched: snapshot.matched ?? 0,
		total: snapshot.total ?? 0,
		unmatched: snapshot.unmatched ?? 0,
		updated: snapshot.updated ?? 0,
	};

	if (snapshot.filesRemoved !== undefined) {
		summary.filesRemoved = snapshot.filesRemoved;
	}

	if (snapshot.unchecked !== undefined) {
		summary.unchecked = snapshot.unchecked;
	}

	if (snapshot.didUpdate !== undefined) {
		summary.didUpdate = snapshot.didUpdate;
	}

	return summary;
}

function buildJestResult(source: unknown): JestResult {
	const validated = validateJestResult(source);
	const snapshot = extractSnapshotSummary(validated);
	if (snapshot !== undefined) {
		return { ...validated, snapshot };
	}

	// `jestResultSchema` does not declare `snapshot`, so a block that failed to
	// parse would otherwise ride through undeclared and reach consumers under a
	// key typed `SnapshotSummary`. Drop it instead.
	const { snapshot: _unparsed, ...rest } = validated;
	return rest;
}

function parseParsedOutput(parsed: JestEnvelope): ParseResult {
	const runner = runnerFields(parsed);
	const coverageData = extractCoverageData(runner);
	const luauTiming = extractLuauTiming(runner);
	const perTestCoverage = extractPerTestCoverage(runner);
	const setupSeconds = extractSetupSeconds(runner);
	const snapshotWrites = extractSnapshotWrites(runner);
	const unwrapped = unwrapResult(parsed, runner);

	if (unwrapped.kind === "ExecutionError") {
		const errorMessage = extractExecutionError(unwrapped);
		throw new LuauScriptError(`Jest execution failed: ${errorMessage}`);
	}

	// The Jest result is either nested under `results` or is the envelope
	// itself; the snapshot summary rides alongside whichever one carries it.
	const { results } = unwrapped;
	return {
		coverageData,
		luauTiming,
		perTestCoverage,
		result: buildJestResult(
			results !== null && typeof results === "object" ? results : unwrapped,
		),
		setupSeconds,
		snapshotWrites,
	};
}
