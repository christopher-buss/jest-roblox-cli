import { type Type, type } from "arktype";

/** Snapshot file contents keyed by path, as the runner wrote them. */
export type SnapshotWrites = Record<string, string>;

/**
 * The `runner` key of an envelope entry, as `luau/runner-result.luau` builds
 * it. Fields stay `unknown`: the parser drops a malformed field, not the
 * entry.
 */
export interface RunnerFields {
	/** Why a failed run was given up on. */
	abandon?: unknown;
	/** Whether a failed run had installed its output capture. */
	captureInstalled?: unknown;
	/** Stable code of a failed run. */
	code?: unknown;
	/** Coverage hits of the run. */
	coverage?: JSONValue;
	/** Coverage hits per test. */
	perTestCoverage?: unknown;
	/** How far a failed run got. */
	phase?: unknown;
	/** Setup time, in seconds. */
	setup?: unknown;
	/** Snapshot files the run wrote. */
	snapshotWrites?: unknown;
	/** Phase timings, in seconds, by phase name. */
	timing?: unknown;
}

/** Decodes {@link RunnerFields}. */
export const runnerFieldsSchema: Type<RunnerFields> = type({
	"abandon?": "unknown",
	"captureInstalled?": "unknown",
	"code?": "unknown",
	"coverage?": type("unknown").as<JSONValue>(),
	"perTestCoverage?": "unknown",
	"phase?": "unknown",
	"setup?": "unknown",
	"snapshotWrites?": "unknown",
	"timing?": "unknown",
});
