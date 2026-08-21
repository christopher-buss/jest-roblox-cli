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
	// Set by a work-stealing task that stopped with items still queued because
	// its return envelope was full. Read via `isEnvelopeDeferred`, which the
	// task pool uses to decide whether to launch another task.
	"deferred?": "boolean",
	"entries": type({
		"bannerOutput?": "string",
		"elapsedMs?": "number",
		"gameOutput?": "string",
		"jestOutput": "string",
		"pkg?": "string",
		"project?": "string",
		"snapshotWrites?": { "[string]": "string" },
	}).array(),
});

export function parseEnvelope(jestOutput: string): Array<EnvelopeEntry> {
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

		return [{ jestOutput }];
	}

	return envelope.entries;
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
		const envelope = envelopeSchema(JSON.parse(jestOutput));
		return !(envelope instanceof type.errors) && envelope.deferred === true;
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
	}: EnvelopeEntry,
	job: ProjectJob,
	fallbackGameOutput: string | undefined,
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
		luauTiming: parsed.luauTiming,
		perTestCoverage: parsed.perTestCoverage,
		result: parsed.result,
		setupMs:
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined,
		snapshotWrites: hasEntryWrites ? snapshotWrites : parsed.snapshotWrites,
	};
}
