import { type } from "arktype";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import type { EnvelopeEntry, ProjectBackendResult, ProjectJob } from "./interface.ts";

// Mirrors parser.ts `unwrapResult`: a top-level {success:false, err} payload is
// a wholesale failure, not an envelope. `err: unknown` requires the key to be
// present; `success: false` pins the literal.
const wholeRunErrorSchema = type({
	err: "unknown",
	success: "false",
});

const envelopeSchema = type({
	// Set by a task that stopped on a failing package under `--bail`: the
	// packages it never reached have no entry, and that gap is expected rather
	// than a broken task.
	"bailed?": "boolean",
	// Set by a work-stealing task that stopped with items still queued because
	// its return envelope was full. The task pool reads it to decide whether to
	// launch another task.
	"deferred?": "boolean",
	"entries": type({
		"bannerOutput?": "string",
		"elapsedMs?": "number",
		"gameOutput?": "string",
		"jestOutput": "string",
		"pkg?": "string",
		"project?": "string",
		"snapshotWrites?": { "[string]": "string" },
		"timedOut?": "boolean",
	}).array(),
	// Set by the run-mode coordinator when the projects ran across VM hosts:
	// the run's game output was captured once, for the batch, so it belongs to
	// no single project. Absent on every sequential run, including a parallel
	// request that found no host to run on.
	"gameOutputScope?": "'batch'",
});

/** One task's return envelope: what it ran, and why it stopped. */
export interface DecodedEnvelope {
	/** A package failed under `--bail`, so the rest were never started. */
	bailed: boolean;
	/**
	 * The return envelope filled up, so another task should collect the rest.
	 */
	deferred: boolean;
	entries: Array<EnvelopeEntry>;
	/**
	 * `"batch"` when the runner captured game output once for the whole run
	 * rather than per project. Undefined when each entry owns its own capture.
	 */
	gameOutputScope?: "batch" | undefined;
}

/**
 * Decode a task's return envelope in one pass.
 *
 * Both stop flags come back alongside the entries because the envelope carries
 * the whole Jest output of every package the task ran — up to Open Cloud's
 * 4 MiB cap — and reading a flag through its own `JSON.parse` would walk all
 * of it a second time.
 */
export function decodeEnvelope(jestOutput: string): DecodedEnvelope {
	const raw = JSON.parse(jestOutput);
	const envelope = envelopeSchema(raw);
	if (envelope instanceof type.errors) {
		// A non-envelope payload is one of two things. A top-level whole-run
		// error ({success:false, err}) means the runtime crashed before emitting
		// any per-job entry: there's no result to map. Re-run it through
		// parseJestOutput, which recognizes that shape and throws a clean
		// LuauScriptError (leaf-cause message), so the caller surfaces the real
		// cause instead of masking it behind the entries-vs-jobs count guard.
		// Anything else is a legacy bare jest result — rewrap it as one entry so
		// buildProjectResult parses it like any other.
		if (!(wholeRunErrorSchema(raw) instanceof type.errors)) {
			parseJestOutput(jestOutput);
		}

		return { bailed: false, deferred: false, entries: [{ jestOutput }] };
	}

	return {
		bailed: envelope.bailed === true,
		deferred: envelope.deferred === true,
		entries: envelope.entries,
		gameOutputScope: envelope.gameOutputScope,
	};
}

export function parseEnvelope(jestOutput: string): Array<EnvelopeEntry> {
	return decodeEnvelope(jestOutput).entries;
}

/**
 * Whether a task stopped with queued work still outstanding.
 *
 * Deliberately lenient — anything malformed reads as "nothing outstanding".
 * This runs while the task pool is still deciding whether to launch more work,
 * so throwing here would be swallowed by the pool's per-task error handling;
 * the strict parse that surfaces a broken task runs once the pool settles.
 */
export function isEnvelopeDeferred(jestOutput: string): boolean {
	try {
		return decodeEnvelope(jestOutput).deferred;
	} catch {
		return false;
	}
}

export function buildProjectResult(
	{
		bannerOutput,
		elapsedMs,
		gameOutput: entryGameOutput,
		jestOutput,
		snapshotWrites,
		timedOut,
	}: EnvelopeEntry,
	job: ProjectJob,
	fallbackGameOutput: string | undefined,
	gameOutputScope?: "batch",
): ProjectBackendResult {
	const gameOutput = entryGameOutput ?? fallbackGameOutput;

	let parsed;
	try {
		parsed = parseJestOutput(jestOutput);
	} catch (err) {
		if (err instanceof LuauScriptError) {
			// Both captures travel on the error so the exec-error path can
			// surface the banner cause (bannerOutput) AND still write the
			// full Game Output dump (gameOutput) to --gameOutput. See
			// CONTEXT.md for the Game Output / Banner Output split.
			err.bannerOutput = bannerOutput;
			err.gameOutput = gameOutput;
			// An abandoned run always decodes to a script failure, so the
			// distinction between "timed out" and "threw" would be lost here
			// unless it rides on the error the report is built from.
			err.timedOut = timedOut;
		}

		throw err;
	}

	// Length check, not `??`: an empty {} from a future malformed
	// producer must not mask a populated runner.snapshotWrites
	// scraped from jestOutput (single-package runner.luau path).
	const hasEntryWrites = snapshotWrites !== undefined && Object.keys(snapshotWrites).length > 0;

	return {
		bannerOutput,
		coverageData: parsed.coverageData,
		displayColor: job.displayColor,
		displayName: job.displayName,
		elapsedMs: elapsedMs ?? 0,
		gameOutput,
		gameOutputScope,
		luauTiming: parsed.luauTiming,
		perTestCoverage: parsed.perTestCoverage,
		result: parsed.result,
		setupMs:
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined,
		snapshotWrites: hasEntryWrites ? snapshotWrites : parsed.snapshotWrites,
	};
}
