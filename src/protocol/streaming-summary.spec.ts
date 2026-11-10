import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { streamingResultSchema } from "./streaming-summary.ts";

describe("streamingResultSchema", () => {
	it("should reject a summary with no package", () => {
		expect.assertions(1);

		expect(
			streamingResultSchema({
				elapsedMs: 1,
				numFailedTests: 0,
				numPassedTests: 1,
				numPendingTests: 0,
				project: "unit",
				success: true,
			}),
		).toBeInstanceOf(type.errors);
	});
});
