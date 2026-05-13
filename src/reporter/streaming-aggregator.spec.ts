import { describe, expect, it, vi } from "vitest";

import type { StreamingResultEntry } from "../memory-store/sorted-map-client.ts";
import { StreamingAggregator, type StreamingAggregatorOnEntry } from "./streaming-aggregator.ts";

function makeEntry(overrides: Partial<StreamingResultEntry> = {}): StreamingResultEntry {
	return {
		elapsedMs: 100,
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		pkg: "@halcyon/foo",
		project: "alpha",
		success: true,
		...overrides,
	};
}

describe(StreamingAggregator, () => {
	describe("accept", () => {
		it("should call onEntry exactly once when streaming mode is enabled", () => {
			expect.assertions(1);

			const onEntry = vi.fn<StreamingAggregatorOnEntry>();
			const aggregator = new StreamingAggregator({ onEntry });

			const entry = makeEntry();
			aggregator.accept(entry);

			expect(onEntry).toHaveBeenCalledExactlyOnceWith(entry);
		});

		it("should ignore duplicate entries for the same pkg/project (work-stealing retry)", () => {
			expect.assertions(2);

			const onEntry = vi.fn<StreamingAggregatorOnEntry>();
			const aggregator = new StreamingAggregator({ onEntry });

			aggregator.accept(makeEntry({ elapsedMs: 1, pkg: "a", project: "p" }));
			aggregator.accept(makeEntry({ elapsedMs: 2, pkg: "a", project: "p" }));

			expect(onEntry).toHaveBeenCalledOnce();
			expect(aggregator.drain()).toHaveLength(1);
		});

		it("should report whether the entry was newly accepted via the return value", () => {
			expect.assertions(2);

			const aggregator = new StreamingAggregator();

			expect(aggregator.accept(makeEntry({ pkg: "a", project: "p" }))).toBeTrue();
			expect(aggregator.accept(makeEntry({ pkg: "a", project: "p" }))).toBeFalse();
		});

		it("should not call onEntry on a duplicate", () => {
			expect.assertions(1);

			const onEntry = vi.fn<StreamingAggregatorOnEntry>();
			const aggregator = new StreamingAggregator({ onEntry });

			aggregator.accept(makeEntry({ pkg: "a", project: "p" }));
			aggregator.accept(makeEntry({ pkg: "a", project: "p" }));

			expect(onEntry).toHaveBeenCalledOnce();
		});

		it("should treat different projects under the same pkg as distinct entries", () => {
			expect.assertions(2);

			const onEntry = vi.fn<StreamingAggregatorOnEntry>();
			const aggregator = new StreamingAggregator({ onEntry });

			aggregator.accept(makeEntry({ pkg: "a", project: "p" }));
			aggregator.accept(makeEntry({ pkg: "a", project: "q" }));

			expect(onEntry).toHaveBeenCalledTimes(2);
			expect(aggregator.drain()).toHaveLength(2);
		});

		it("should accept entries with no onEntry hook (buffer-only mode)", () => {
			expect.assertions(2);

			const aggregator = new StreamingAggregator();

			expect(aggregator.accept(makeEntry())).toBeTrue();
			expect(aggregator.drain()).toHaveLength(1);
		});
	});

	describe("drain", () => {
		it("should return entries in arrival order", () => {
			expect.assertions(1);

			const aggregator = new StreamingAggregator();

			aggregator.accept(makeEntry({ pkg: "first", project: "p" }));
			aggregator.accept(makeEntry({ pkg: "second", project: "p" }));
			aggregator.accept(makeEntry({ pkg: "third", project: "p" }));

			expect(aggregator.drain().map((entry) => entry.pkg)).toStrictEqual([
				"first",
				"second",
				"third",
			]);
		});

		it("should return an empty array when nothing was accepted", () => {
			expect.assertions(1);

			const aggregator = new StreamingAggregator();

			expect(aggregator.drain()).toStrictEqual([]);
		});

		it("should return a snapshot copy so subsequent accepts don't mutate it", () => {
			expect.assertions(2);

			const aggregator = new StreamingAggregator();

			aggregator.accept(makeEntry({ pkg: "first", project: "p" }));
			const snapshot = aggregator.drain();
			aggregator.accept(makeEntry({ pkg: "second", project: "p" }));

			expect(snapshot).toHaveLength(1);
			expect(aggregator.drain()).toHaveLength(2);
		});
	});
});
