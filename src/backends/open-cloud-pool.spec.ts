import type { ScriptResult } from "@isentinel/roblox-runner";
import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
	captureStderr,
	envelope,
	packageJobIndex,
	scriptResult,
} from "#test/mocks/spec-open-cloud.ts";
import type {
	StreamingResultReader,
	StreamingResultRecord,
} from "../memory-store/sorted-map-client.ts";
import { drainDeferralsAsync, drainStealingPoolAsync } from "./open-cloud-pool.ts";

interface StubStreamReader extends StreamingResultReader {
	deleted: Array<string>;
	readCalls: number;
}

type ExecuteStep = () => Promise<ScriptResult> | ScriptResult;

function createStreamReader(pages: Array<Array<StreamingResultRecord>>): StubStreamReader {
	const reader: StubStreamReader = {
		deleteAsync: async (itemId): Promise<void> => {
			reader.deleted.push(itemId);
		},
		deleted: [],
		readAllAsync: async (): Promise<Array<StreamingResultRecord>> => {
			const index = Math.min(reader.readCalls, pages.length - 1);
			reader.readCalls += 1;
			return pages[index] ?? [];
		},
		readCalls: 0,
	};
	return reader;
}

function successJest(): string {
	return JSON.stringify({ success: true });
}

function packageEntry(packageName: string) {
	return { jestOutput: successJest(), jobIndex: packageJobIndex(packageName), pkg: packageName };
}

async function drainWithFailingReaderAsync(fail: () => never): Promise<Array<string>> {
	const { restore, writes } = captureStderr();
	const reader: StubStreamReader = {
		deleteAsync: async (): Promise<void> => {
			/* unused */
		},
		deleted: [],
		readAllAsync: async (): Promise<never> => {
			reader.readCalls += 1;
			fail();
		},
		readCalls: 0,
	};

	await drainStealingPoolAsync({
		requiredKeyCount: 1,
		runTask: async () => scriptResult(envelope([packageEntry("alpha")])),
		streaming: {
			onPackageResult: () => {
				/* unused */
			},
			reader,
		},
		taskCount: 1,
	});
	restore();
	return writes;
}

/**
 * Runs `steps[callIndex]`, repeating the final step once the list is
 * exhausted.
 *
 * @param steps - Task bodies, in call order.
 * @returns A mock task.
 */
function stepTask(steps: Array<ExecuteStep>) {
	let callIndex = 0;
	return vi.fn<() => Promise<ScriptResult>>(async () => {
		const step = steps[Math.min(callIndex, steps.length - 1)]!;
		callIndex += 1;
		return step();
	});
}

function deferred(packageName: string): ExecuteStep {
	return () => scriptResult(envelope([packageEntry(packageName)], { deferred: true }));
}

function settled(...packageNames: Array<string>): ExecuteStep {
	return () => scriptResult(envelope(packageNames.map(packageEntry)));
}

describe(drainStealingPoolAsync, () => {
	it("should launch a replacement task when a worker defers queued work", async () => {
		expect.assertions(1);

		// Open Cloud rejects a task returning over 4 MiB, so a worker whose
		// envelope fills up stops early and leaves the rest of the queue.
		// The deferral must earn exactly one replacement launch, or the
		// packages it left behind never come back.
		const runTask = stepTask([deferred("alpha"), settled("beta"), settled("gamma")]);

		await drainStealingPoolAsync({
			requiredKeyCount: 3,
			runTask,
			streaming: undefined,
			taskCount: 2,
		});

		expect(runTask).toHaveBeenCalledTimes(3);
	});

	it("should stop relaunching once every deferral has been answered", async () => {
		expect.assertions(1);

		// A replacement that drains the queue ends the chain. Without the
		// claim on launch, the same deferral could be answered twice and
		// the wave would keep firing tasks that have nothing left to do.
		const runTask = stepTask([deferred("alpha"), settled("beta"), settled("gamma"), settled()]);

		await drainStealingPoolAsync({
			requiredKeyCount: 3,
			runTask,
			streaming: undefined,
			taskCount: 2,
		});

		expect(runTask).toHaveBeenCalledTimes(3);
	});

	it("should bound the replacement chain when every task keeps deferring", async () => {
		expect.assertions(1);

		// A worker always takes at least one item, so a run can never need
		// more than one extra task per job.
		const runTask = stepTask([deferred("alpha")]);

		const results = await drainStealingPoolAsync({
			requiredKeyCount: 2,
			runTask,
			streaming: undefined,
			taskCount: 2,
		});

		// parallel (2) + one launch per job (2).
		expect(results).toHaveLength(4);
	});

	it("should fail when a task errors even if a sibling covers every package", async () => {
		expect.assertions(1);

		/**
		 * The shared pool folds a task failure into a freed slot and
		 * resolves, so without a post-pool guard the failure would be masked
		 * whenever a sibling task drains the whole queue.
		 */
		const runTask = stepTask([
			settled("alpha", "beta"),
			() => {
				throw new Error("open cloud task crashed");
			},
		]);

		await expect(
			drainStealingPoolAsync({
				requiredKeyCount: 2,
				runTask,
				streaming: undefined,
				taskCount: 2,
			}),
		).rejects.toThrow(/open cloud task crashed/);
	});

	it("should deliver streaming entries to onPackageResult and delete each one", async () => {
		expect.assertions(3);

		const reader = createStreamReader([
			[
				{
					id: "alpha::client",
					value: {
						elapsedMs: 50,
						numFailedTests: 0,
						numPassedTests: 1,
						numPendingTests: 0,
						pkg: "alpha",
						project: "client",
						success: true,
					},
				},
			],
			[],
		]);
		const seen: Array<string> = [];

		async function executeAsync(): Promise<ScriptResult> {
			// Let the polling loop tick once before the task finishes so
			// the entry is consumed mid-flight rather than only on the
			// final drain.
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 10);
			});
			return scriptResult(
				envelope([{ jestOutput: successJest(), pkg: "alpha", project: "client" }]),
			);
		}

		await drainStealingPoolAsync({
			requiredKeyCount: 1,
			runTask: async () => executeAsync(),
			streaming: {
				onPackageResult: (entry) => {
					seen.push(entry.pkg);
				},
				reader,
			},
			taskCount: 1,
		});

		expect(seen).toContain("alpha");
		expect(reader.deleted).toContain("alpha::client");
		expect(reader.readCalls).toBeGreaterThanOrEqual(1);
	});

	it("should poll on its own cadence under fake timers", async () => {
		expect.assertions(2);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const reader = createStreamReader([
			[
				{
					id: "alpha::alpha",
					value: {
						elapsedMs: 1,
						numFailedTests: 0,
						numPassedTests: 1,
						numPendingTests: 0,
						pkg: "alpha",
						project: "alpha",
						success: true,
					},
				},
			],
			[],
		]);
		const seen: Array<string> = [];

		const promise = drainStealingPoolAsync({
			requiredKeyCount: 1,
			runTask: async () => scriptResult(envelope([packageEntry("alpha")])),
			streaming: {
				onPackageResult: (entry) => {
					seen.push(entry.pkg);
				},
				reader,
			},
			taskCount: 1,
		});
		await vi.runAllTimersAsync();
		await promise;

		expect(seen).toContain("alpha");
		expect(reader.deleted).toContain("alpha::alpha");
	});

	it("should emit a one-shot stderr warning when the streaming reader returns a PermissionError", async () => {
		expect.assertions(2);

		const { PermissionError } = await import("@bedrock-rbx/ocale");
		const writes = await drainWithFailingReaderAsync(() => {
			throw new Error("Failed to read streaming results: forbidden", {
				cause: new PermissionError("forbidden", {
					operationKey: "memory-store-sorted-maps.list",
					requiredScopes: ["memory-store.sorted-map:read"],
					statusCode: 403,
				}),
			});
		});

		const joined = writes.join("");

		expect(joined).toContain("memory-store.sorted-map:read");
		// Only one warning even though the failing read happens twice (poll
		// + final drain).
		expect(writes.filter((line) => line.includes("streaming disabled"))).toHaveLength(1);
	});

	it("should pluralize the scope hint when the PermissionError carries multiple scopes", async () => {
		expect.assertions(1);

		const { PermissionError } = await import("@bedrock-rbx/ocale");
		const writes = await drainWithFailingReaderAsync(() => {
			throw new Error("forbidden", {
				cause: new PermissionError("forbidden", {
					operationKey: "memory-store-sorted-maps.list",
					requiredScopes: ["scope-a", "scope-b"],
					statusCode: 403,
				}),
			});
		});

		expect(writes.join("")).toContain("missing scopes scope-a, scope-b");
	});

	it("should stringify a non-Error thrown by the streaming reader", async () => {
		expect.assertions(1);

		const writes = await drainWithFailingReaderAsync(() => {
			// oxlint-disable-next-line typescript/only-throw-error -- exercising the non-Error branch in drainOnce's catch.
			throw "string-error";
		});

		expect(writes.join("")).toContain("string-error");
	});

	it("should emit a one-shot stderr warning for non-permission streaming reader errors", async () => {
		expect.assertions(2);

		const { restore, writes } = captureStderr();

		const reader = {
			deleteAsync: async (): Promise<void> => {
				/* unused */
			},
			deleted: [],
			readAllAsync: async (): Promise<never> => {
				reader.readCalls += 1;
				throw new Error("network broke");
			},
			readCalls: 0,
		};

		await drainStealingPoolAsync({
			requiredKeyCount: 1,
			runTask: async () => scriptResult(envelope([packageEntry("alpha")])),
			streaming: {
				onPackageResult: () => {
					/* unused */
				},
				reader,
			},
			taskCount: 1,
		});
		restore();

		expect(reader.readCalls).toBe(2);
		expect(writes).toStrictEqual([
			"Warning: live per-package streaming disabled — network broke\n",
			"  Tests still run; results print as usual once each task finishes.\n",
		]);
	});

	it("should swallow streaming reader errors so they don't fail the run", async () => {
		expect.assertions(1);

		const reader = {
			deleteAsync: async () => {
				/* unused */
			},
			deleted: [],
			readAllAsync: async () => {
				reader.readCalls += 1;
				throw new Error("read failed");
			},
			readCalls: 0,
		};

		const results = await drainStealingPoolAsync({
			requiredKeyCount: 1,
			runTask: async () => scriptResult(envelope([packageEntry("alpha")])),
			streaming: {
				onPackageResult: () => {
					/* unused */
				},
				reader,
			},
			taskCount: 1,
		});

		expect(results).toHaveLength(1);
	});

	it("should swallow streaming delete errors after forwarding the entry", async () => {
		expect.assertions(4);

		const seen: Array<string> = [];
		const { restore, writes } = captureStderr();
		let deletionCount = 0;
		const reader = {
			deleteAsync: async () => {
				deletionCount += 1;
				throw new Error("delete failed");
			},
			deleted: [],
			readAllAsync: async () => {
				reader.readCalls += 1;
				return [
					{
						id: "alpha::default",
						value: {
							elapsedMs: 0,
							numFailedTests: 0,
							numPassedTests: 1,
							numPendingTests: 0,
							pkg: "alpha",
							project: "default",
							success: true,
						},
					},
				];
			},
			readCalls: 0,
		};

		const results = await drainStealingPoolAsync({
			requiredKeyCount: 1,
			runTask: async () => scriptResult(envelope([packageEntry("alpha")])),
			streaming: {
				onPackageResult: (entry) => {
					seen.push(entry.pkg);
				},
				reader,
			},
			taskCount: 1,
		});
		restore();

		expect(seen).toContain("alpha");
		expect(results).toHaveLength(1);
		expect(deletionCount).toBeGreaterThanOrEqual(1);
		expect(writes).toStrictEqual([
			"Warning: live per-package streaming disabled — delete failed\n",
			"  Tests still run; results print as usual once each task finishes.\n",
		]);
	});
});

describe(drainDeferralsAsync, () => {
	it("should keep bail on the script it re-sends for deferred entries", async () => {
		expect.assertions(2);

		const scripts: Array<string> = [];
		const steps = [deferred("alpha"), settled("beta")];

		await drainDeferralsAsync({
			bail: true,
			entries: ["alpha", "beta"].map((name, runnerJobIndex) => {
				return fromAny({ config: { runnerJobIndex }, pkg: name, project: name });
			}),
			runScript: async (script) => {
				scripts.push(script);
				return steps[scripts.length - 1]!();
			},
		});

		expect(scripts).toHaveLength(2);
		expect(scripts[1]).toContain('"bail":true');
	});

	it("should not mark the drain bailed when no task bails", async () => {
		expect.assertions(1);

		const result = await drainDeferralsAsync({
			bail: false,
			entries: [fromAny({ config: { runnerJobIndex: 0 }, pkg: "alpha", project: "alpha" })],
			runScript: async () => settled("alpha")(),
		});

		expect(result.bailed).toBeFalse();
	});
});
