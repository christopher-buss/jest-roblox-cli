import { describe, expectTypeOf, it } from "vitest";

import { createTimingCollector } from "./orchestration-collector.ts";

describe("createTimingCollector", () => {
	const collector = createTimingCollector({ enabled: false });

	it("should reject Promise-returning functions in the sync profile", () => {
		// @ts-expect-error sync profile must not silently measure only
		// scheduling time
		void collector.profile("phase", async () => 1);
	});

	it("should return the synchronous function's value type from profile", () => {
		expectTypeOf(collector.profile("phase", () => 42)).toEqualTypeOf<number>();
	});

	it("should accept a Promise-returning function in profileAsync", () => {
		expectTypeOf(collector.profileAsync("phase", async () => 42)).toEqualTypeOf<
			Promise<number>
		>();
	});
});
