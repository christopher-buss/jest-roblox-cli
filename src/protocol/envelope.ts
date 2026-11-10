import { type Type, type } from "arktype";

import type { RunnerAbandon, RunnerErrorCode, RunnerPhase } from "./runner-error.ts";

/** The `gameOutputScope` of a run that captured game output once for all. */
export const BATCH_GAME_OUTPUT_SCOPE = "batch";

/** One package or project entry from a task's return envelope. */
export interface EnvelopeEntry {
	/** Banner text Jest printed before its results. */
	bannerOutput?: string | undefined;
	/** Game output captured while the entry ran. */
	gameOutput?: string | undefined;
	/** Raw Jest JSON output for the entry. */
	jestOutput: string;
}

/** An envelope entry as it crosses the wire, naming the job it answers. */
export interface WireEnvelopeEntry extends EnvelopeEntry {
	/** Index of the job in the CLI's request. */
	jobIndex: number;
}

/** One task's return envelope, as it crosses the wire. */
export interface TaskEnvelope {
	/**
	 * Set by a task that stopped on a failing package under `--bail`: the
	 * packages it never reached have no entry.
	 */
	bailed?: boolean;
	/**
	 * Set by a work-stealing task that stopped with items still queued because
	 * its return envelope was full.
	 */
	deferred?: boolean;
	/** One entry per package or project the task ran. */
	entries: Array<WireEnvelopeEntry>;
	/**
	 * Set when the projects ran across VM hosts and the run's game output was
	 * captured once, for the batch.
	 */
	gameOutputScope?: typeof BATCH_GAME_OUTPUT_SCOPE;
}

export const taskEnvelopeSchema: Type<TaskEnvelope> = type({
	"bailed?": "boolean",
	"deferred?": "boolean",
	"entries": type({
		"bannerOutput?": "string",
		"gameOutput?": "string",
		"jestOutput": "string",
		"jobIndex": "number.integer >= 0",
	}).array(),
	"gameOutputScope?": "'batch'",
});

/** What a runner measured about a run that produced no result. */
export interface FailureRunnerFields {
	/** Why the run was given up on. */
	abandon?: RunnerAbandon;
	/** Whether the runner installed its output capture before it failed. */
	captureInstalled?: boolean;
	/** Stable code of the failure, when the runner knows one. */
	code?: RunnerErrorCode;
	/** How far the run got. */
	phase?: RunnerPhase;
}

/**
 * The whole-run failure payload: a run that produced no Jest result.
 *
 * @param err - Why the run failed.
 * @param runner - What the runner measured about it, if anything.
 * @returns The encoded payload.
 */
export function encodeRunFailure(err: string, runner?: FailureRunnerFields): string {
	return JSON.stringify({ err, runner, success: false });
}

/**
 * The Luau table literal of {@link encodeRunFailure} for an error known only
 * at run time, for a script the CLI generates.
 *
 * @param errorExpression - Luau expression that evaluates to the message.
 * @returns The table literal.
 */
export function luauRunFailure(errorExpression: string): string {
	return `{ err = ${errorExpression}, success = false }`;
}

/** Joins a workspace entry's package and project into one key. */
export const ENTRY_KEY_SEPARATOR = "::";

/**
 * The key that names a workspace entry across the wire.
 *
 * @param packageName - Package that owns the entry.
 * @param project - Project inside the package.
 * @returns `package::project`.
 */
export function entryKey(packageName: string, project: string): string {
	return `${packageName}${ENTRY_KEY_SEPARATOR}${project}`;
}
