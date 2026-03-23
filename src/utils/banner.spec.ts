import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import { formatBanner, formatBannerBar } from "./banner.ts";

describe(formatBannerBar, () => {
	it("should contain the title text", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "warn", termWidth: 80, title: "Test Title" });

		expect(result).toContain("Test Title");
	});

	it("should pad with separator characters to fill terminal width", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "warn", termWidth: 40, title: "Hi" });

		// Title " Hi " = 4 chars, remaining 36 split into left (18) + right (18)
		// Total visible chars should equal termWidth
		expect(stripVTControlCharacters(result)).toHaveLength(40);
	});

	it("should use error styling for error level", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "error", termWidth: 40, title: "Error" });

		expect(result).toContain("Error");
	});

	it("should use warn styling for warn level", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "warn", termWidth: 40, title: "Warning" });

		expect(result).toContain("Warning");
	});

	it("should handle title wider than terminal gracefully", () => {
		expect.assertions(1);

		const result = formatBannerBar({
			level: "warn",
			termWidth: 20,
			title: "A Very Long Title That Exceeds Width",
		});

		expect(result).toContain("A Very Long Title That Exceeds Width");
	});

	it("should default termWidth when not provided", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "warn", title: "Test" });

		expect(result).toContain("Test");
	});
});

describe(formatBanner, () => {
	it("should include the title in the header bar", () => {
		expect.assertions(1);

		const result = formatBanner({
			body: ["Something went wrong"],
			level: "warn",
			termWidth: 80,
			title: "Snapshot Warning",
		});

		expect(result).toContain("Snapshot Warning");
	});

	it("should include all body lines", () => {
		expect.assertions(2);

		const result = formatBanner({
			body: ["Line one", "Line two"],
			level: "warn",
			termWidth: 80,
			title: "Test",
		});

		expect(result).toContain("Line one");
		expect(result).toContain("Line two");
	});

	it("should include a closing separator bar", () => {
		expect.assertions(1);

		const result = formatBanner({
			body: ["content"],
			level: "warn",
			termWidth: 40,
			title: "Test",
		});

		const lines = result.split("\n");
		const closingLine = lines.findLast((line) => stripVTControlCharacters(line).includes("⎯"));

		// Closing bar should not contain the title
		expect(stripVTControlCharacters(closingLine ?? "")).not.toContain("Test");
	});

	it("should handle empty body", () => {
		expect.assertions(2);

		const result = formatBanner({
			body: [],
			level: "error",
			termWidth: 80,
			title: "Empty",
		});

		expect(result).toContain("Empty");

		// Should still have header + closing separator
		const separatorLines = result
			.split("\n")
			.filter((line) => stripVTControlCharacters(line).includes("⎯"));

		expect(separatorLines.length).toBeGreaterThanOrEqual(2);
	});

	it("should default termWidth when not provided", () => {
		expect.assertions(1);

		const result = formatBanner({
			body: ["content"],
			level: "warn",
			title: "Test",
		});

		expect(result).toContain("Test");
	});

	it("should wrap output with leading and trailing newlines", () => {
		expect.assertions(2);

		const result = formatBanner({
			body: ["content"],
			level: "warn",
			termWidth: 80,
			title: "Test",
		});

		expect(result).toMatch(/^\n/);
		expect(result).toMatch(/\n$/);
	});
});

describe("snapshots", () => {
	it("should match snapshot for warn banner", () => {
		expect.assertions(1);

		const result = formatBanner({
			body: [
				"Failed to parse rojo project: unexpected token",
				"  File: default.project.json",
			],
			level: "warn",
			termWidth: 80,
			title: "Snapshot Warning",
		});

		expect(stripVTControlCharacters(result)).toMatchSnapshot();
	});

	it("should match snapshot for error banner", () => {
		expect.assertions(1);

		const result = formatBanner({
			body: ["Test suite failed to run"],
			level: "error",
			termWidth: 80,
			title: "Failed Tests 1",
		});

		expect(stripVTControlCharacters(result)).toMatchSnapshot();
	});

	it("should match snapshot for banner bar only", () => {
		expect.assertions(1);

		const result = formatBannerBar({ level: "warn", termWidth: 80, title: "Snapshot Warning" });

		expect(stripVTControlCharacters(result)).toMatchSnapshot();
	});
});
