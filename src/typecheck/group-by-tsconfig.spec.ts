import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";

import type { JestResult } from "../types/jest-result.ts";
import type { RunTypecheckGroup } from "./group-by-tsconfig.ts";
import { groupTypecheckByTsconfig, runTypecheckPassAsync } from "./group-by-tsconfig.ts";

interface Deferred {
	promise: Promise<JestResult>;
	resolve: (result: JestResult) => void;
}

function makeResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	};
}

/** One group fails, so the merge is exercised over a mixed pass/fail pair. */
function resultForTsconfig(tsconfig?: string): JestResult {
	const isFailing = tsconfig === "b.json";
	return makeResult({
		numFailedTests: isFailing ? 1 : 0,
		numPendingTests: isFailing ? 2 : 1,
		numTotalTests: isFailing ? 3 : 2,
		success: !isFailing,
	});
}

/** Out-of-order start times, so the merge has to take the earliest. */
function startTimeForCwd(cwd: string): number {
	return cwd === "/a" ? 50 : 20;
}

function deferred(): Deferred {
	let resolveResult!: (result: JestResult) => void;
	const promise = new Promise<JestResult>((resolve) => {
		resolveResult = resolve;
	});
	return { promise, resolve: resolveResult };
}

describe(groupTypecheckByTsconfig, () => {
	it("should run one pass for a single project entry", async () => {
		expect.assertions(2);

		const run = vi.fn<RunTypecheckGroup>(async () => {
			return makeResult({ numPassedTests: 1, numTotalTests: 1 });
		});

		const result = await groupTypecheckByTsconfig(
			[{ cwd: "/root", files: ["a.spec-d.ts"], tsconfig: "tsconfig.json" }],
			run,
		);

		expect(run).toHaveBeenCalledWith({
			cwd: "/root",
			files: ["a.spec-d.ts"],
			tsconfig: "tsconfig.json",
		});
		expect(result).toStrictEqual(makeResult({ numPassedTests: 1, numTotalTests: 1 }));
	});

	it("should check projects with distinct tsconfigs against their own", async () => {
		expect.assertions(3);

		const run = vi.fn<RunTypecheckGroup>(async (group) => resultForTsconfig(group.tsconfig));

		const result = await groupTypecheckByTsconfig(
			[
				{ cwd: "/r", files: ["a.spec-d.ts"], tsconfig: "a.json" },
				{ cwd: "/r", files: ["b.spec-d.ts"], tsconfig: "b.json" },
			],
			run,
		);

		expect(run).toHaveBeenCalledWith({ cwd: "/r", files: ["a.spec-d.ts"], tsconfig: "a.json" });
		expect(run).toHaveBeenCalledWith({ cwd: "/r", files: ["b.spec-d.ts"], tsconfig: "b.json" });
		expect(result).toStrictEqual(
			makeResult({
				numFailedTests: 1,
				numPendingTests: 3,
				numTotalTests: 5,
				success: false,
			}),
		);
	});

	it("should collapse projects sharing a tsconfig into one pass with deduped files", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await groupTypecheckByTsconfig(
			[
				{ cwd: "/r", files: ["a.spec-d.ts", "shared.spec-d.ts"], tsconfig: "t.json" },
				{ cwd: "/r", files: ["shared.spec-d.ts", "b.spec-d.ts"], tsconfig: "t.json" },
			],
			run,
		);

		expect(run).toHaveBeenCalledExactlyOnceWith({
			cwd: "/r",
			files: ["a.spec-d.ts", "shared.spec-d.ts", "b.spec-d.ts"],
			tsconfig: "t.json",
		});
	});

	it("should run separate passes for the same tsconfig under different roots", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await groupTypecheckByTsconfig(
			[
				{ cwd: "/a", files: ["x.spec-d.ts"], tsconfig: "t.json" },
				{ cwd: "/b", files: ["y.spec-d.ts"], tsconfig: "t.json" },
			],
			run,
		);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("should not collide a cwd and tsconfig that share a boundary substring", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await groupTypecheckByTsconfig(
			[
				{ cwd: "/a b", files: ["x.spec-d.ts"], tsconfig: "c" },
				{ cwd: "/a", files: ["y.spec-d.ts"], tsconfig: "b c" },
			],
			run,
		);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("should omit tsconfig when unset and take the earliest start time", async () => {
		expect.assertions(2);

		const run = vi.fn<RunTypecheckGroup>(async (group) => {
			return makeResult({ startTime: startTimeForCwd(group.cwd) });
		});

		const result = await groupTypecheckByTsconfig(
			[
				{ cwd: "/a", files: ["x.spec-d.ts"] },
				{ cwd: "/b", files: ["y.spec-d.ts"] },
			],
			run,
		);

		expect(run).toHaveBeenCalledWith({ cwd: "/a", files: ["x.spec-d.ts"] });
		expect(result!.startTime).toBe(20);
	});

	it("should return undefined when no entries are given", async () => {
		expect.assertions(2);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		const result = await groupTypecheckByTsconfig([], run);

		expect(result).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("should skip entries that carry no files", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await groupTypecheckByTsconfig(
			[
				{ cwd: "/r", files: [], tsconfig: "t.json" },
				{ cwd: "/r", files: ["a.spec-d.ts"], tsconfig: "t.json" },
			],
			run,
		);

		expect(run).toHaveBeenCalledExactlyOnceWith({
			cwd: "/r",
			files: ["a.spec-d.ts"],
			tsconfig: "t.json",
		});
	});

	it("should run multiple tsconfig groups concurrently", async () => {
		expect.assertions(2);

		const first = deferred();
		const second = deferred();
		const run = vi
			.fn<RunTypecheckGroup>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);

		const pending = groupTypecheckByTsconfig(
			[
				{ cwd: "/r", files: ["a.spec-d.ts"], tsconfig: "a.json" },
				{ cwd: "/r", files: ["b.spec-d.ts"], tsconfig: "b.json" },
			],
			run,
		);

		// Both groups start before either resolves — a sequential pass would
		// leave the second group un-invoked until the first settled.
		expect(run).toHaveBeenCalledTimes(2);

		first.resolve(makeResult({ numPassedTests: 1, numTotalTests: 1 }));
		second.resolve(makeResult({ numPassedTests: 1, numTotalTests: 1 }));

		const result = await pending;

		expect(result).toStrictEqual(makeResult({ numPassedTests: 2, numTotalTests: 2 }));
	});
});

describe(runTypecheckPassAsync, () => {
	it("should skip the clock and runner when no entries exist", async () => {
		expect.assertions(3);

		const run = vi.fn<RunTypecheckGroup>();
		const now = vi.spyOn(performance, "now");

		await expect(runTypecheckPassAsync([], run)).resolves.toStrictEqual({ elapsedMs: 0 });
		expect(run).not.toHaveBeenCalled();
		expect(now).not.toHaveBeenCalled();
	});

	it("should return the exact elapsed time and merged result", async () => {
		expect.assertions(2);

		vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(25);
		const result = makeResult({ numPassedTests: 1, numTotalTests: 1 });
		const run = vi.fn<RunTypecheckGroup>().mockResolvedValue(result);
		const entry = { cwd: "/root", files: ["a.spec-d.ts"], tsconfig: "tsconfig.json" };

		await expect(runTypecheckPassAsync([entry], run)).resolves.toStrictEqual({
			elapsedMs: 15,
			result,
		});
		expect(run).toHaveBeenCalledExactlyOnceWith(entry);
	});
});
