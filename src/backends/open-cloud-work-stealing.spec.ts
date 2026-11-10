import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import type { prepareWorkStealingQueueAsync } from "../memory-store/work-stealing.ts";
import type { MaterializerInput } from "../runner-payload/materializer-script.ts";
import {
	tryStealingDispatchAsync,
	type WorkStealingDispatchInput,
} from "./open-cloud-work-stealing.ts";

interface DispatchedPayload {
	bailMapId?: string;
	entries: Array<{ pkg: string; project: string }>;
	invisibilityWindowSeconds?: number;
	queueId?: string;
	queueTtlSeconds?: number;
	sortedMapId?: string;
}

function payloadOf(script: string): DispatchedPayload {
	const embedded = /JSONDecode\(\[(=+)\[([\S\s]*?)]\1]/.exec(script);
	assert(embedded !== null);
	return fromAny<DispatchedPayload, JSONValue>(JSON.parse(embedded[2]!));
}

function makeInput({
	budgetMs = 60_000,
	packageName,
}: {
	readonly budgetMs?: number;
	readonly packageName: string;
}): MaterializerInput {
	const budget = budgetMs > 0 ? { runnerTimeoutMs: budgetMs } : {};
	return {
		config: { ...budget, runnerJobIndex: 0, testMatch: ["**/*.spec"] },
		pkg: packageName,
		project: "unit",
	};
}

function stubQueue(): ReturnType<typeof vi.fn<typeof prepareWorkStealingQueueAsync>> {
	return vi.fn<typeof prepareWorkStealingQueueAsync>(async (options) => {
		return {
			invisibilityWindowSeconds: options.perPackageTimeoutSeconds + 30,
			queueId: "queue-1",
			ttlSeconds: 600,
		};
	});
}

function makeDispatchInput(
	overrides: Partial<WorkStealingDispatchInput> = {},
): WorkStealingDispatchInput {
	return {
		bail: false,
		credentials: { apiKey: "key", universeId: "42" },
		generateUuid: () => "uuid-1",
		inputs: [makeInput({ packageName: "pkg-a" })],
		prepareWorkStealingQueue: stubQueue(),
		taskTimeout: 300_000,
		...overrides,
	};
}

async function windowSecondsForAsync(
	inputs: Array<MaterializerInput>,
): Promise<number | undefined> {
	const prepareWorkStealingQueue = stubQueue();
	await tryStealingDispatchAsync(makeDispatchInput({ inputs, prepareWorkStealingQueue }));
	return prepareWorkStealingQueue.mock.calls[0]?.[0].perPackageTimeoutSeconds;
}

describe(tryStealingDispatchAsync, () => {
	it("should surface a script failure instead of reporting a queue setup failure", async () => {
		expect.assertions(1);

		await expect(
			tryStealingDispatchAsync(
				makeDispatchInput({
					bail: true,
					generateUuid: () => {
						throw new Error("uuid boom");
					},
				}),
			),
		).rejects.toThrow("uuid boom");
	});

	it("should return a work-stealing script when queue setup succeeds", async () => {
		expect.assertions(2);

		const prepareWorkStealingQueue = stubQueue();

		const spec = await tryStealingDispatchAsync(
			makeDispatchInput({
				credentials: { apiKey: "key", baseUrl: "https://example.test", universeId: "42" },
				prepareWorkStealingQueue,
			}),
		);

		expect(prepareWorkStealingQueue).toHaveBeenCalledExactlyOnceWith({
			baseUrl: "https://example.test",
			credentials: { apiKey: "key", universeId: "42" },
			packages: [{ pkg: "pkg-a", project: "unit" }],
			perPackageTimeoutSeconds: 60,
		});

		assert(spec !== undefined, "expected a stealing dispatch");

		expect({ ...spec, script: payloadOf(spec.script) }).toStrictEqual({
			script: {
				entries: [expect.objectContaining({ pkg: "pkg-a", project: "unit" })],
				invisibilityWindowSeconds: 90,
				queueId: "queue-1",
				queueTtlSeconds: 600,
			},
			streaming: undefined,
		});
	});

	it("should size the invisibility window off the slowest package's budget", async () => {
		expect.assertions(1);

		await expect(
			windowSecondsForAsync([
				makeInput({ packageName: "pkg-a" }),
				makeInput({ budgetMs: 180_000, packageName: "pkg-b" }),
			]),
		).resolves.toBe(180);
	});

	// A package with no budget of its own is bounded only by the deadline
	// Roblox gives the whole task, so that is the window a sibling must wait
	// out before reclaiming it.
	it("should fall back to the task deadline for a package with no budget", async () => {
		expect.assertions(1);

		await expect(
			windowSecondsForAsync([makeInput({ budgetMs: 0, packageName: "pkg-a" })]),
		).resolves.toBe(300);
	});

	// A budget past the task deadline cannot be reached: Roblox ends the task
	// first. Waiting it out only delays the reclaim of an item whose worker is
	// already gone.
	it("should cap a package budget at the task deadline", async () => {
		expect.assertions(1);

		await expect(
			windowSecondsForAsync([makeInput({ budgetMs: 900_000, packageName: "pkg-a" })]),
		).resolves.toBe(300);
	});

	it("should size an empty batch's window at zero", async () => {
		expect.assertions(1);

		await expect(windowSecondsForAsync([])).resolves.toBe(0);
	});

	it("should give a bailing script its own bail map", async () => {
		expect.assertions(1);

		const spec = await tryStealingDispatchAsync(makeDispatchInput({ bail: true }));
		assert(spec !== undefined, "expected a stealing dispatch");

		expect(payloadOf(spec.script).bailMapId).toBe("uuid-1");
	});

	it("should stream results to the consumer when one is given", async () => {
		expect.assertions(2);

		const spec = await tryStealingDispatchAsync(
			makeDispatchInput({ onPackageResult: vi.fn<() => void>() }),
		);
		assert(spec !== undefined, "expected a stealing dispatch");

		expect(payloadOf(spec.script).sortedMapId).toBe("uuid-1");
		expect(spec.streaming!.onPackageResult).toBeTypeOf("function");
	});

	it("should warn and return undefined when queue setup fails", async () => {
		expect.assertions(2);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		onTestFinished(() => {
			stderr.mockRestore();
		});

		const spec = await tryStealingDispatchAsync(
			makeDispatchInput({
				prepareWorkStealingQueue: vi.fn<typeof prepareWorkStealingQueueAsync>(async () => {
					throw new Error("missing scope");
				}),
			}),
		);

		expect(spec).toBeUndefined();
		expect(stderr).toHaveBeenCalledExactlyOnceWith(
			"Warning: could not set up the work-stealing queue, running packages " +
				"with no work-stealing: missing scope\n" +
				"Grant the API key memory-store.queue:add/dequeue/discard so tasks " +
				"can rebalance instead of running a fixed share each.\n",
		);
	});
});
