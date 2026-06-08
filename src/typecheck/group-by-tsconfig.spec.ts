import { describe, expect, it, vi } from "vitest";

import type { JestResult } from "../types/jest-result.ts";
import type { RunTypecheckGroup } from "./group-by-tsconfig.ts";
import { groupTypecheckByTsconfig } from "./group-by-tsconfig.ts";

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

		const run = vi.fn<RunTypecheckGroup>(async (group) => {
			return makeResult({
				numFailedTests: group.tsconfig === "b.json" ? 1 : 0,
				numTotalTests: 1,
				success: group.tsconfig !== "b.json",
			});
		});

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
			makeResult({ numFailedTests: 1, numTotalTests: 2, success: false }),
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
			return makeResult({ startTime: group.cwd === "/a" ? 50 : 20 });
		});

		const result = await groupTypecheckByTsconfig(
			[
				{ cwd: "/a", files: ["x.spec-d.ts"] },
				{ cwd: "/b", files: ["y.spec-d.ts"] },
			],
			run,
		);

		expect(run).toHaveBeenCalledWith({ cwd: "/a", files: ["x.spec-d.ts"] });
		expect(result?.startTime).toBe(20);
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
