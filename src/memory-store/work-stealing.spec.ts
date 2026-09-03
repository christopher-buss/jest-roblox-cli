import { createJsonWorkQueueWriter, type WorkQueueWriter } from "@isentinel/roblox-runner";

import { describe, expect, it, vi } from "vitest";

import { prepareWorkStealingQueueAsync } from "./work-stealing.ts";

interface EnqueueCall {
	items: ReadonlyArray<unknown>;
	options?: { ttlMs?: number };
}

function createQueueStub(enqueueImpl?: () => Promise<void>) {
	const enqueueCalls: Array<EnqueueCall> = [];
	const queueIds: Array<string> = [];

	function factory(queueId: string): WorkQueueWriter<{ pkg: string; project: string }> {
		queueIds.push(queueId);
		const queue = createJsonWorkQueueWriter<{ pkg: string; project: string }>({
			apiKey: "test-key",
			queueId,
			universeId: "123",
		});
		vi.spyOn(queue, "enqueueAsync").mockImplementation(
			async (items, options): Promise<void> => {
				enqueueCalls.push(options === undefined ? { items } : { items, options });
				if (enqueueImpl) {
					await enqueueImpl();
				}
			},
		);
		return queue;
	}

	return { enqueueCalls, factory, queueIds };
}

const CREDENTIALS = { apiKey: "test-key", universeId: "123" };

describe(prepareWorkStealingQueueAsync, () => {
	it("should push every package onto a per-run UUID-keyed queue with default TTL", async () => {
		expect.assertions(3);

		const { enqueueCalls, factory, queueIds } = createQueueStub();

		await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [
				{ pkg: "@halcyon/foo", project: "alpha" },
				{ pkg: "@halcyon/bar", project: "beta" },
			],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "queue-uuid-1",
		});

		expect(queueIds).toStrictEqual(["queue-uuid-1"]);
		expect(enqueueCalls).toHaveLength(1);
		expect(enqueueCalls[0]!.options!.ttlMs).toBe(600_000);
	});

	it("should accept a custom ttlSeconds override", async () => {
		expect.assertions(1);

		const { enqueueCalls, factory } = createQueueStub();

		await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [{ pkg: "@halcyon/foo", project: "alpha" }],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			ttlSeconds: 120,
			uuid: () => "qid",
		});

		expect(enqueueCalls[0]!.options!.ttlMs).toBe(120_000);
	});

	it("should set invisibilityWindowSeconds to perPackageTimeoutSeconds + 30", async () => {
		expect.assertions(1);

		const { factory } = createQueueStub();

		const prepared = await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "qid",
		});

		expect(prepared.invisibilityWindowSeconds).toBe(90);
	});

	// The runner re-queues an item it dropped over budget, and the put-back has
	// to name a TTL. Reporting the one the items were seeded with is what keeps
	// an override from stopping at this function.
	it("should report the TTL it seeded the items with", async () => {
		expect.assertions(2);

		const { factory } = createQueueStub();
		const options = {
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "qid",
		};

		const fallback = await prepareWorkStealingQueueAsync(options);
		const overridden = await prepareWorkStealingQueueAsync({ ...options, ttlSeconds: 120 });

		expect(fallback.ttlSeconds).toBe(600);
		expect(overridden.ttlSeconds).toBe(120);
	});

	it("should return the queueId produced by the injected uuid generator", async () => {
		expect.assertions(1);

		const { factory } = createQueueStub();

		const prepared = await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "specific-uuid",
		});

		expect(prepared.queueId).toBe("specific-uuid");
	});

	it("should push the full packages array into a single enqueue call", async () => {
		expect.assertions(1);

		const { enqueueCalls, factory } = createQueueStub();

		await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [{ pkg: "@halcyon/foo", project: "alpha" }],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "qid",
		});

		expect(enqueueCalls[0]!.items).toStrictEqual([{ pkg: "@halcyon/foo", project: "alpha" }]);
	});

	it("should call enqueue with empty items array when packages array is empty", async () => {
		expect.assertions(2);

		const { enqueueCalls, factory } = createQueueStub();

		const prepared = await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "qid",
		});

		expect(enqueueCalls[0]!.items).toStrictEqual([]);
		expect(prepared.queueId).toBe("qid");
	});

	it("should propagate errors from queue.enqueue", async () => {
		expect.assertions(1);

		const { factory } = createQueueStub(async () => {
			throw new Error("queue full");
		});

		await expect(
			prepareWorkStealingQueueAsync({
				credentials: CREDENTIALS,
				packages: [{ pkg: "alpha", project: "p1" }],
				perPackageTimeoutSeconds: 60,
				queueFactory: factory,
				uuid: () => "qid",
			}),
		).rejects.toThrow("queue full");
	});

	it("should default to crypto.randomUUID when no uuid override is provided", async () => {
		expect.assertions(1);

		const { factory } = createQueueStub();

		const prepared = await prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
		});

		expect(prepared.queueId).toMatch(
			/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
		);
	});

	it("should construct a real queue writer when no factory is provided", () => {
		expect.assertions(1);

		// Just confirming construction succeeds — actual HTTP would fail without
		// mocks; this exercises the default factory branch.
		const promise = prepareWorkStealingQueueAsync({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			uuid: () => "qid",
		});

		expect(promise).toBeInstanceOf(Promise);
	});

	it("should construct a real queue writer with a custom baseUrl when provided", () => {
		expect.assertions(1);

		// Exercises the baseUrl-defined branch of the default factory path.
		const promise = prepareWorkStealingQueueAsync({
			baseUrl: "http://127.0.0.1:4010",
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			uuid: () => "qid",
		});

		expect(promise).toBeInstanceOf(Promise);
	});
});
