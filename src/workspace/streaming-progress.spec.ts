import { describe, expect, it } from "vitest";

import { createPlainStyles } from "#test/mocks/format-plain-styles.ts";
import { createTaggedStyles } from "#test/mocks/format-tagged-styles.ts";
import type { StreamingResultEntry } from "../protocol/streaming-summary.ts";
import { formatStreamingProgressLine } from "./streaming-progress.ts";

function entry(overrides: Partial<StreamingResultEntry> = {}): StreamingResultEntry {
	return {
		elapsedMs: 1234,
		numFailedTests: 0,
		numPassedTests: 3,
		numPendingTests: 0,
		pkg: "@halcyon/foo",
		project: "@halcyon/foo",
		success: true,
		...overrides,
	};
}

describe(formatStreamingProgressLine, () => {
	it("should emit a passing line with pkg, count, and elapsed time", () => {
		expect.assertions(1);

		expect(formatStreamingProgressLine(entry(), createPlainStyles())).toBe(
			"▶ @halcyon/foo  3 passed (1234ms)",
		);
	});

	it("should include a failed count when failures are present", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(
				entry({
					numFailedTests: 2,
					numPassedTests: 1,
					success: false,
				}),
				createPlainStyles(),
			),
		).toBe("▶ @halcyon/foo  2 failed | 1 passed (1234ms)");
	});

	it("should append the project name when it differs from the package", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(entry({ project: "client" }), createPlainStyles()),
		).toContain("@halcyon/foo › client");
	});

	it("should include skipped tests in the breakdown when present", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(
				entry({ numPassedTests: 2, numPendingTests: 1 }),
				createPlainStyles(),
			),
		).toBe("▶ @halcyon/foo  2 passed | 1 skipped (1234ms)");
	});

	it("should render '0 tests' when the result has no passed/failed/skipped", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(
				entry({ numFailedTests: 0, numPassedTests: 0, numPendingTests: 0 }),
				createPlainStyles(),
			),
		).toBe("▶ @halcyon/foo  0 tests (1234ms)");
	});

	it("should paint the arrow, each count and the elapsed time through the palette", () => {
		expect.assertions(1);

		const out = formatStreamingProgressLine(
			entry({
				numFailedTests: 1,
				numPassedTests: 1,
				numPendingTests: 1,
				success: false,
			}),
			createTaggedStyles(),
		);

		expect(out).toBe(
			"<location>▶</location> @halcyon/foo  <fail>1 failed</fail> | <pass>1 passed</pass> | <pending>1 skipped</pending> <dim>(1234ms)</dim>",
		);
	});
});
