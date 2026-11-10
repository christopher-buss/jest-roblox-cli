import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";

import type { JestResult } from "../types/jest-result-types.ts";
import type { RunTypecheck } from "./runner.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "./typecheck-groups.ts";
import { assertTypecheckAvailable, runPolicyTypecheckPassAsync } from "./typecheck-groups.ts";

type RunTypecheckGroup = (group: TypecheckGroupEntry) => Promise<JestResult>;

interface Deferred {
	promise: Promise<JestResult>;
	resolve: (result: JestResult) => void;
}

function makeResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 0,
		snapshot: undefined,
		startTime: 0,
		success: true,
		testResults: [],
		...overrides,
	};
}

/**
 * One group fails, so the merge is exercised over a mixed pass/fail pair.
 * @param tsconfig - The group's tsconfig; `b.json` fails.
 * @returns The group's result.
 */
function resultForTsconfig(tsconfig?: string): JestResult {
	const isFailing = tsconfig === "b.json";
	return makeResult({
		numFailedTests: isFailing ? 1 : 0,
		numPendingTests: isFailing ? 2 : 1,
		numTotalTests: isFailing ? 3 : 2,
		success: !isFailing,
	});
}

/**
 * Out-of-order start times, so the merge has to take the earliest.
 * @param cwd - The group's working directory.
 * @returns The group's start time.
 */
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

async function runTypecheckPassAsync(
	entries: ReadonlyArray<TypecheckGroupEntry>,
	run: RunTypecheckGroup,
): Promise<TypecheckPassOutcome> {
	return runPolicyTypecheckPassAsync({
		entries,
		policyByDirectory: new Map(entries.map(({ cwd }) => [cwd, {}])),
		runTypecheck: async ({ files, rootDir, tsconfig }) => {
			return run({ cwd: rootDir, files, tsconfig });
		},
	});
}

async function passResultAsync(
	...args: Parameters<typeof runTypecheckPassAsync>
): Promise<JestResult | undefined> {
	const pass = await runTypecheckPassAsync(...args);
	return pass.result;
}

describe("runPolicyTypecheckPassAsync grouping", () => {
	it("should run one pass for a single project entry", async () => {
		expect.assertions(2);

		const run = vi.fn<RunTypecheckGroup>(async () => {
			return makeResult({ numPassedTests: 1, numTotalTests: 1 });
		});

		const result = await passResultAsync(
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

		const result = await passResultAsync(
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

		await passResultAsync(
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

		await passResultAsync(
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

		await passResultAsync(
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

		const result = await passResultAsync(
			[
				{ cwd: "/a", files: ["x.spec-d.ts"] },
				{ cwd: "/b", files: ["y.spec-d.ts"] },
			],
			run,
		);

		expect(run).toHaveBeenCalledWith({ cwd: "/a", files: ["x.spec-d.ts"] });
		expect(result!.startTime).toBe(20);
	});

	it("should group luau files by cwd alone across distinct tsconfigs", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await passResultAsync(
			[
				{ cwd: "/r", files: ["a.spec-d.luau"], tsconfig: "a.json" },
				{ cwd: "/r", files: ["b.spec-d.luau"], tsconfig: "b.json" },
			],
			run,
		);

		expect(run).toHaveBeenCalledExactlyOnceWith({
			cwd: "/r",
			files: ["a.spec-d.luau", "b.spec-d.luau"],
			tsconfig: undefined,
		});
	});

	it("should run luau and typescript files of one entry as separate groups", async () => {
		expect.assertions(3);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await passResultAsync(
			[{ cwd: "/r", files: ["a.spec-d.ts", "b.spec-d.luau"], tsconfig: "a.json" }],
			run,
		);

		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenCalledWith({ cwd: "/r", files: ["a.spec-d.ts"], tsconfig: "a.json" });
		expect(run).toHaveBeenCalledWith({
			cwd: "/r",
			files: ["b.spec-d.luau"],
			tsconfig: undefined,
		});
	});

	it("should run separate luau groups under different roots", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await passResultAsync(
			[
				{ cwd: "/a", files: ["a.spec-d.luau"] },
				{ cwd: "/b", files: ["b.spec-d.luau"] },
			],
			run,
		);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("should return undefined when no entry carries files", async () => {
		expect.assertions(2);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		const result = await passResultAsync([{ cwd: "/r", files: [], tsconfig: "t.json" }], run);

		expect(result).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("should skip entries that carry no files", async () => {
		expect.assertions(1);

		const run = vi.fn<RunTypecheckGroup>(async () => makeResult());

		await passResultAsync(
			[
				{ cwd: "/r", files: [], tsconfig: "unused.json" },
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

		const pending = passResultAsync(
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

describe("runPolicyTypecheckPassAsync timing", () => {
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

describe(assertTypecheckAvailable, () => {
	it.for<[string, Array<Array<string>>]>([
		["a later entry", [["a.spec-d.luau"], ["b.spec-d.ts"]]],
		["a later file", [["a.spec-d.luau", "b.spec-d.ts"]]],
	])("should reject TypeScript Type Tests in %s under the standalone binary", ([, groups]) => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const entries = groups.map((files) => ({ cwd: "/project", files }));

		expect(() => {
			assertTypecheckAvailable(entries);
		}).toThrow("--typecheck is not available in the standalone binary");
	});

	it("should allow Luau Type Tests under the standalone binary", () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		expect(() => {
			assertTypecheckAvailable([{ cwd: "/project", files: ["a.spec-d.luau"] }]);
		}).not.toThrow();
	});
});

describe(runPolicyTypecheckPassAsync, () => {
	it("should check each group under the policy of its cwd and finish it", async () => {
		expect.assertions(2);

		const runTypecheck = vi.fn<RunTypecheck>(async () => makeResult({ numTotalTests: 1 }));
		const policy = { ignoreSourceErrors: true, spawnTimeout: 9, timeout: 1234 };

		const outcome = await runPolicyTypecheckPassAsync({
			entries: [{ cwd: "/a", files: ["x.spec-d.ts"], tsconfig: "t.json" }],
			finishGroup: (result, applied) => ({ ...result, numTotalTests: applied.timeout }),
			policyByDirectory: new Map([["/a", policy]]),
			runTypecheck,
		});

		expect(runTypecheck).toHaveBeenCalledExactlyOnceWith({
			files: ["x.spec-d.ts"],
			ignoreSourceErrors: true,
			rootDir: "/a",
			spawnTimeout: 9,
			timeout: 1234,
			tsconfig: "t.json",
		});
		expect(outcome.result!.numTotalTests).toBe(1234);
	});

	it("should pass a group's result through when no finisher is given", async () => {
		expect.assertions(1);

		const result = makeResult({ numTotalTests: 4 });

		const outcome = await runPolicyTypecheckPassAsync({
			entries: [{ cwd: "/a", files: ["x.spec-d.ts"] }],
			policyByDirectory: new Map([["/a", { timeout: 1 }]]),
			runTypecheck: async () => result,
		});

		expect(outcome.result!.numTotalTests).toBe(4);
	});

	it("should reject a group whose cwd has no policy", async () => {
		expect.assertions(1);

		await expect(
			runPolicyTypecheckPassAsync({
				entries: [{ cwd: "/b", files: ["x.spec-d.ts"] }],
				policyByDirectory: new Map([["/a", { timeout: 1 }]]),
				runTypecheck: async () => makeResult(),
			}),
		).rejects.toThrow("no Type Test policy for /b");
	});
});
