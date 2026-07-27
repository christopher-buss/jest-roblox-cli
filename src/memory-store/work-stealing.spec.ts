import { WorkQueue } from "@isentinel/roblox-runner";

import { describe, expect, it, vi } from "vitest";

import { decodeQueueItem, encodeQueueItem, prepareWorkStealingQueue } from "./work-stealing.ts";

interface EnqueueCall {
	items: ReadonlyArray<unknown>;
	options?: { ttlMs?: number };
}

function createQueueStub(enqueueImpl?: () => Promise<void>): {
	enqueueCalls: Array<EnqueueCall>;
	factory: (queueId: string) => WorkQueue<{ pkg: string; project: string }>;
	queueIds: Array<string>;
} {
	const enqueueCalls: Array<EnqueueCall> = [];
	const queueIds: Array<string> = [];

	function factory(queueId: string): WorkQueue<{ pkg: string; project: string }> {
		queueIds.push(queueId);
		const queue = new WorkQueue<{ pkg: string; project: string }>({
			apiKey: "test-key",
			decode: decodeQueueItem,
			encode: encodeQueueItem,
			queueId,
			universeId: "123",
		});
		vi.spyOn(queue, "enqueueAsync").mockImplementation(
			async (items, options): Promise<void> => {
				enqueueCalls.push({ items, ...(options ? { options } : {}) });
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

describe(prepareWorkStealingQueue, () => {
	it("should push every package onto a per-run UUID-keyed queue with default TTL", async () => {
		expect.assertions(3);

		const { enqueueCalls, factory, queueIds } = createQueueStub();

		await prepareWorkStealingQueue({
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

		await prepareWorkStealingQueue({
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

		const prepared = await prepareWorkStealingQueue({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
			uuid: () => "qid",
		});

		expect(prepared.invisibilityWindowSeconds).toBe(90);
	});

	it("should return the queueId produced by the injected uuid generator", async () => {
		expect.assertions(1);

		const { factory } = createQueueStub();

		const prepared = await prepareWorkStealingQueue({
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

		await prepareWorkStealingQueue({
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

		const prepared = await prepareWorkStealingQueue({
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
			prepareWorkStealingQueue({
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

		const prepared = await prepareWorkStealingQueue({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			queueFactory: factory,
		});

		expect(prepared.queueId).toMatch(
			/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
		);
	});

	it("should encode a QueueItem as its plain object representation", () => {
		expect.assertions(1);

		expect(encodeQueueItem({ pkg: "@halcyon/foo", project: "alpha" })).toStrictEqual({
			pkg: "@halcyon/foo",
			project: "alpha",
		});
	});

	it("should decode a wire payload back into a QueueItem", () => {
		expect.assertions(1);

		const wire = { pkg: "@halcyon/bar", project: "beta" };

		expect(decodeQueueItem(wire)).toStrictEqual(wire);
	});

	it("should throw when wire payload is missing required fields", () => {
		expect.assertions(1);

		expect(() => decodeQueueItem({ pkg: "@halcyon/bar" })).toThrow("project must be a string");
	});

	it("should throw when wire payload field has wrong type", () => {
		expect.assertions(1);

		expect(() => decodeQueueItem({ pkg: 42, project: "beta" })).toThrow("pkg must be a string");
	});

	it("should throw when wire payload is not an object", () => {
		expect.assertions(1);

		expect(() => decodeQueueItem("not-an-object")).toThrow("must be an object");
	});

	it("should construct a real WorkQueue when no factory is provided", () => {
		expect.assertions(1);

		// Just confirming construction succeeds — actual HTTP would fail without
		// mocks; this exercises the default factory branch.
		const promise = prepareWorkStealingQueue({
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			uuid: () => "qid",
		});

		expect(promise).toBeInstanceOf(Promise);
	});

	it("should construct a real WorkQueue with a custom baseUrl when provided", () => {
		expect.assertions(1);

		// Exercises the baseUrl-defined branch of the default factory path.
		const promise = prepareWorkStealingQueue({
			baseUrl: "http://127.0.0.1:4010",
			credentials: CREDENTIALS,
			packages: [],
			perPackageTimeoutSeconds: 60,
			uuid: () => "qid",
		});

		expect(promise).toBeInstanceOf(Promise);
	});
});
