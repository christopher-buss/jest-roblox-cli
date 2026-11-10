import { type } from "arktype";

import { LuauScriptError } from "../jest-output/luau-script-error.ts";
import { parseJestOutput } from "../jest-output/parser.ts";
import {
	type EnvelopeEntry,
	taskEnvelopeSchema,
	type WireEnvelopeEntry,
} from "../protocol/envelope.ts";
import type { ProjectBackendResult } from "./interface.ts";

/** One task's return envelope: what it ran, and why it stopped. */
export interface DecodedEnvelope {
	/** A package failed under `--bail`, so the rest were never started. */
	bailed: boolean;
	/** The return envelope filled up; another task collects the rest. */
	deferred: boolean;
	/** Entries the task returned, one per package or project it ran. */
	entries: Array<WireEnvelopeEntry>;
	/** `"batch"` when the game output belongs to the whole run. */
	gameOutputScope?: "batch" | undefined;
}

/** One envelope entry plus the run-wide game output. */
export interface ProjectResultInput extends EnvelopeEntry {
	/** Game output to use when the entry has none of its own. */
	readonly fallbackGameOutput: string | undefined;
	/** `"batch"` when the game output belongs to the whole run. */
	readonly gameOutputScope?: "batch" | undefined;
}

/**
 * Decode a task's return envelope in one pass.
 *
 * @param jestOutput - Raw task output.
 * @returns The stop flags, entries, and game output scope.
 * @throws {@link LuauScriptError} When the output is a whole-run error.
 * @throws {@link Error} When the output is no task envelope.
 */
export function decodeEnvelope(jestOutput: string): DecodedEnvelope {
	const raw = JSON.parse(jestOutput);
	const envelope = taskEnvelopeSchema(raw);
	if (envelope instanceof type.errors) {
		parseJestOutput(jestOutput);

		throw new Error(`The runner returned no task envelope: ${envelope.summary}`);
	}

	return {
		bailed: envelope.bailed === true,
		deferred: envelope.deferred === true,
		entries: envelope.entries,
		gameOutputScope: envelope.gameOutputScope,
	};
}

/**
 * Whether a task stopped with queued work still outstanding.
 *
 * @param jestOutput - Raw task output.
 * @returns True when the task deferred queued work.
 */
export function isEnvelopeDeferred(jestOutput: string): boolean {
	try {
		return decodeEnvelope(jestOutput).deferred;
	} catch {
		return false;
	}
}

/**
 * Parse one envelope entry into a project result.
 *
 * @param options - The entry and the run-wide game output.
 * @returns The parsed project result.
 * @throws {@link LuauScriptError} When the Jest output is a script error; the
 *   error carries the entry's banner and game output.
 */
export function buildProjectResult({
	bannerOutput,
	fallbackGameOutput,
	gameOutput: entryGameOutput,
	gameOutputScope,
	jestOutput,
}: ProjectResultInput): ProjectBackendResult {
	const gameOutput = entryGameOutput ?? fallbackGameOutput;

	let parsed;
	try {
		parsed = parseJestOutput(jestOutput);
	} catch (err) {
		if (err instanceof LuauScriptError) {
			err.bannerOutput = bannerOutput;
			err.gameOutput = gameOutput;
		}

		throw err;
	}

	return {
		coverageData: parsed.coverageData,
		gameOutput,
		gameOutputScope,
		perTestCoverage: parsed.perTestCoverage,
		result: parsed.result,
		setupMs:
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined,
		snapshotWrites: parsed.snapshotWrites,
	};
}
