import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { EnvelopeEntry, ProjectJob } from "./interface.ts";
import {
	aggregateEntriesByKey,
	collectStealingResults,
	parseStealingEnvelope,
} from "./open-cloud-entries.ts";

function job(displayName: string, packageName?: string): ProjectJob {
	return {
		config: createResolvedConfig(),
		displayName,
		pkg: packageName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function entry(
	packageName: string | undefined,
	{ elapsedMs = 0, project }: { elapsedMs?: number; project?: string } = {},
): EnvelopeEntry {
	return {
		elapsedMs,
		jestOutput: "{}",
		pkg: packageName,
		...(project === undefined ? {} : { project }),
	};
}

function task(entries: Array<EnvelopeEntry>, gameOutput = "[]") {
	return { entries, gameOutput };
}

function collect({
	bailed = false,
	jobs,
	tasks,
}: {
	bailed?: boolean;
	jobs: Array<ProjectJob>;
	tasks: Array<ReturnType<typeof task>>;
}) {
	return collectStealingResults({ bailed, entryByKey: aggregateEntriesByKey(tasks), jobs });
}

describe(aggregateEntriesByKey, () => {
	it("should drop duplicate-pkg entries from fault-recovery and keep the first occurrence", () => {
		expect.assertions(1);

		const { rawResults } = collect({
			jobs: [job("alpha"), job("beta")],
			tasks: [
				task([entry("alpha", { elapsedMs: 1 }), entry("beta", { elapsedMs: 2 })]),
				task([entry("alpha", { elapsedMs: 99 })]),
			],
		});

		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([1, 2]);
	});

	it("should silently skip envelope entries with no pkg field", () => {
		expect.assertions(1);

		const entryByKey = aggregateEntriesByKey([
			task([entry(undefined), entry("alpha", { elapsedMs: 42 })]),
		]);

		expect([...entryByKey.keys()]).toStrictEqual(["alpha"]);
	});

	it("should match entries to jobs by pkg::project so multi-project packages don't collide", () => {
		expect.assertions(1);

		const { rawResults } = collect({
			jobs: [job("client", "@halcyon/foo"), job("server", "@halcyon/foo")],
			tasks: [
				task([
					entry("@halcyon/foo", { elapsedMs: 5, project: "client" }),
					entry("@halcyon/foo", { elapsedMs: 9, project: "server" }),
				]),
			],
		});

		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([5, 9]);
	});
});

describe(collectStealingResults, () => {
	it("should pair each entry with the game output its task returned", () => {
		expect.assertions(1);

		const { rawResults } = collect({
			jobs: [job("alpha")],
			tasks: [task([entry("alpha")], "game")],
		});

		expect(rawResults).toStrictEqual([{ entry: entry("alpha"), fallbackGameOutput: "game" }]);
	});

	it("should error when a job has no matching entry in any envelope", () => {
		expect.assertions(1);

		expect(() => {
			return collect({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				tasks: [task([entry("alpha")])],
			});
		}).toThrow(/no entries for 2 package\(s\): beta, gamma/);
	});

	it("should report the jobs a bailed task never reached", () => {
		expect.assertions(1);

		const outcome = collect({
			bailed: true,
			jobs: [job("alpha"), job("beta"), job("gamma")],
			tasks: [task([entry("alpha")])],
		});

		expect(outcome).toStrictEqual({
			bailedJobIndices: [1, 2],
			rawResults: [{ entry: entry("alpha"), fallbackGameOutput: "[]" }],
		});
	});

	it("should report no bailed jobs when a bailed task still covered them all", () => {
		expect.assertions(2);

		const { bailedJobIndices, rawResults } = collect({
			bailed: true,
			jobs: [job("alpha"), job("beta")],
			tasks: [task([entry("alpha"), entry("beta")])],
		});

		expect(rawResults).toHaveLength(2);
		expect(bailedJobIndices).toStrictEqual([]);
	});
});

describe(parseStealingEnvelope, () => {
	it("should decode the envelope and keep the task's game output", () => {
		expect.assertions(1);

		const result: ScriptResult = {
			durationMs: 0,
			outputs: [JSON.stringify({ bailed: true, entries: [entry("alpha")] }), "game"],
		};

		expect(parseStealingEnvelope(result)).toMatchObject({
			bailed: true,
			entries: [entry("alpha")],
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
