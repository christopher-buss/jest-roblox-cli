import { type } from "arktype";

import { LuauScriptError, parseJestOutput } from "../reporter/parser.ts";
import type { EnvelopeEntry, ProjectBackendResult, ProjectJob } from "./interface.ts";

const envelopeSchema = type({
	entries: type({
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
		throw new Error(jestOutput);
	}

	return envelope.entries;
}

export function buildProjectResult(
	entry: EnvelopeEntry,
	job: ProjectJob,
	fallbackGameOutput: string | undefined,
): ProjectBackendResult {
	const {
		bannerOutput,
		elapsedMs,
		gameOutput: entryGameOutput,
		jestOutput,
		snapshotWrites,
	} = entry;
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
	// producer must not mask a populated parsed._snapshotWrites
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
