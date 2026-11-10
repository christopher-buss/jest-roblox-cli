import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import type { WireEnvelopeEntry } from "../protocol/envelope.ts";
import {
	aggregateEntriesByJob,
	parseStealingEnvelope,
	toDispatchOutcome,
} from "./open-cloud-entries.ts";

function entry(
	jobIndex: number,
	{ jestOutput = "{}" }: { jestOutput?: string } = {},
): WireEnvelopeEntry {
	return { jestOutput, jobIndex };
}

function task(entries: Array<WireEnvelopeEntry>, gameOutput = "[]") {
	return { entries, gameOutput };
}

describe(aggregateEntriesByJob, () => {
	it("should keep the first entry of a job that fault recovery ran twice", () => {
		expect.assertions(1);

		const collected = aggregateEntriesByJob([
			task([entry(0, { jestOutput: "1" }), entry(1, { jestOutput: "2" })]),
			task([entry(0, { jestOutput: "99" })]),
		]);

		expect(
			Array.from(collected.values(), ({ entry: { jestOutput } }) => jestOutput),
		).toStrictEqual(["1", "2"]);
	});

	it("should key every entry by the job index it names", () => {
		expect.assertions(1);

		const collected = aggregateEntriesByJob([task([entry(3), entry(1)])]);

		expect([...collected.keys()]).toStrictEqual([3, 1]);
	});
});

describe(toDispatchOutcome, () => {
	it("should pair each entry with its job index and the game output its task returned", () => {
		expect.assertions(1);

		const outcome = toDispatchOutcome(true, aggregateEntriesByJob([task([entry(2)], "game")]));

		expect(outcome).toStrictEqual({
			bailed: true,
			rawResults: [
				{
					entry: { jestOutput: "{}" },
					fallbackGameOutput: "game",
					jobIndex: 2,
				},
			],
		});
	});
});

describe(parseStealingEnvelope, () => {
	it("should decode the envelope and keep the task's game output", () => {
		expect.assertions(1);

		const result: ScriptResult = {
			durationMs: 0,
			outputs: [JSON.stringify({ bailed: true, entries: [entry(0)] }), "game"],
		};

		expect(parseStealingEnvelope(result)).toMatchObject({
			bailed: true,
			entries: [entry(0)],
			gameOutput: "game",
		});
	});

	it("should throw when the task returned no outputs", () => {
		expect.assertions(1);

		expect(() => parseStealingEnvelope({ durationMs: 0, outputs: [] })).toThrow(
			"No test results in output. Got: []",
		);
	});
});
