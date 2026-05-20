import { type } from "arktype";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import type { EnvelopeEntry, ProjectBackendResult, ProjectJob } from "./interface.ts";

const envelopeSchema = type({
	entries: type({
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
		return [{ jestOutput }];
	}

	return envelope.entries;
}

export function buildProjectResult(
	entry: EnvelopeEntry,
	job: ProjectJob,
	fallbackGameOutput: string | undefined,
): ProjectBackendResult {
	const gameOutput = entry.gameOutput ?? fallbackGameOutput;

	let parsed;
	try {
		parsed = parseJestOutput(entry.jestOutput);
	} catch (err) {
		if (err instanceof LuauScriptError) {
			err.gameOutput = gameOutput;
		}

		throw err;
	}

	// Length check, not `??`: an empty {} from a future malformed
	// producer must not mask a populated parsed._snapshotWrites
	// scraped from jestOutput (single-package runner.luau path).
	const entryWrites = entry.snapshotWrites;
	const hasEntryWrites = entryWrites !== undefined && Object.keys(entryWrites).length > 0;

	return {
		coverageData: parsed.coverageData,
		displayColor: job.displayColor,
		displayName: job.displayName,
		elapsedMs: entry.elapsedMs ?? 0,
		gameOutput,
		luauTiming: parsed.luauTiming,
		result: parsed.result,
		setupMs:
			parsed.setupSeconds !== undefined ? Math.round(parsed.setupSeconds * 1000) : undefined,
		snapshotWrites: hasEntryWrites ? entryWrites : parsed.snapshotWrites,
	};
}
