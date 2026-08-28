import { describe, expect, it } from "vitest";

import { mapWithLimitAsync } from "./concurrency.ts";

interface Gate {
	/** Resolves the call for `index`, letting its worker take the next item. */
	release: (index: number, value: string) => void;
	/** How many calls have been made but not yet resolved. */
	started: Array<number>;
	track: (item: string, index: number) => Promise<string>;
}

/**
 * A `func` whose calls hang until released, so a test can look at how many are
 * outstanding at once rather than inferring it from timing.
 */
function createGate(): Gate {
	const resolvers = new Map<number, (value: string) => void>();
	const started: Array<number> = [];
	return {
		release: (index, value) => {
			const resolve = resolvers.get(index);
			resolve?.(value);
		},
		started,
		track: async (_item, index) => {
			started.push(index);
			return new Promise<string>((resolve) => {
				resolvers.set(index, resolve);
			});
		},
	};
}

/** Lets every pending microtask run, so a released worker can take its next. */
async function settleAsync(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) {
		await Promise.resolve();
	}
}

describe(mapWithLimitAsync, () => {
	it("should keep no more than `limit` calls outstanding", async () => {
		expect.assertions(3);

		const gate = createGate();
		const items = ["a", "b", "c", "d", "e"];
		const pending = mapWithLimitAsync(items, 2, gate.track);
		await settleAsync();

		expect(gate.started).toStrictEqual([0, 1]);

		gate.release(0, "A");
		await settleAsync();

		// One freed worker takes exactly one more, rather than the rest.
		expect(gate.started).toStrictEqual([0, 1, 2]);

		for (const [index, item] of items.entries()) {
			gate.release(index, item.toUpperCase());
			await settleAsync();
		}

		await expect(pending).resolves.toStrictEqual(["A", "B", "C", "D", "E"]);
	});

	it("should return results in the order of the items, not of settling", async () => {
		expect.assertions(1);

		const gate = createGate();
		const pending = mapWithLimitAsync(["a", "b", "c"], 3, gate.track);
		await settleAsync();

		// Backwards, so the input order cannot come from the settle order.
		gate.release(2, "C");
		gate.release(1, "B");
		gate.release(0, "A");

		await expect(pending).resolves.toStrictEqual(["A", "B", "C"]);
	});

	it("should run one at a time when the limit is below one", async () => {
		expect.assertions(2);

		const gate = createGate();
		const pending = mapWithLimitAsync(["a", "b"], 0, gate.track);
		await settleAsync();

		expect(gate.started).toStrictEqual([0]);

		gate.release(0, "A");
		// Only now does the one worker reach the second item, so only now is
		// there a call to release.
		await settleAsync();
		gate.release(1, "B");

		await expect(pending).resolves.toStrictEqual(["A", "B"]);
	});

	it("should not spawn more workers than there are items", async () => {
		expect.assertions(2);

		const gate = createGate();
		const pending = mapWithLimitAsync(["a"], 32, gate.track);
		await settleAsync();

		expect(gate.started).toStrictEqual([0]);

		gate.release(0, "A");

		await expect(pending).resolves.toStrictEqual(["A"]);
	});

	it("should answer an empty item list without calling `func`", async () => {
		expect.assertions(2);

		const gate = createGate();

		await expect(mapWithLimitAsync([], 4, gate.track)).resolves.toStrictEqual([]);
		expect(gate.started).toStrictEqual([]);
	});
});
