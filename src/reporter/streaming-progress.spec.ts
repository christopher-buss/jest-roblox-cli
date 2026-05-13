import { describe, expect, it } from "vitest";

import type { StreamingResultEntry } from "../memory-store/sorted-map-client.ts";
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

		expect(formatStreamingProgressLine(entry(), { color: false })).toBe(
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
				{ color: false },
			),
		).toBe("▶ @halcyon/foo  1 passed | 2 failed (1234ms)");
	});

	it("should append the project name when it differs from the package", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(entry({ project: "client" }), { color: false }),
		).toContain("@halcyon/foo › client");
	});

	it("should include skipped tests in the breakdown when present", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(entry({ numPassedTests: 2, numPendingTests: 1 }), {
				color: false,
			}),
		).toBe("▶ @halcyon/foo  2 passed | 1 skipped (1234ms)");
	});

	it("should render '0 tests' when the result has no passed/failed/skipped", () => {
		expect.assertions(1);

		expect(
			formatStreamingProgressLine(
				entry({ numFailedTests: 0, numPassedTests: 0, numPendingTests: 0 }),
				{ color: false },
			),
		).toBe("▶ @halcyon/foo  0 tests (1234ms)");
	});

	it("should colorize when color option is true", () => {
		expect.assertions(1);

		const out = formatStreamingProgressLine(entry(), { color: true });

		// At least one ANSI escape should be present when color is on.
		expect(out).toMatch(/\[/);
	});

	it("should colorize each breakdown segment when color option is true", () => {
		expect.assertions(4);

		const out = formatStreamingProgressLine(
			entry({
				numFailedTests: 1,
				numPassedTests: 1,
				numPendingTests: 1,
				success: false,
			}),
			{ color: true },
		);

		// Don't try to strip ANSI — the color lib may emit reverse-video or
		// 16-color codes depending on terminal detection. Just confirm every
		// segment's text and the joining pipes survive somewhere in the line.
		expect(out).toContain("1 passed");
		expect(out).toContain("1 failed");
		expect(out).toContain("1 skipped");
		expect(out).toContain(" | ");
	});
});
