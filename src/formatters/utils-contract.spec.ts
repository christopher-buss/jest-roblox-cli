import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import type { FormatterEntry } from "../config/schema.ts";
import {
	findFormatterOptions,
	hasFormatter,
	isDefaultHumanFormatter,
	usesAgentFormatter,
} from "./utils.ts";

describe(findFormatterOptions, () => {
	it("should return empty options for a bare formatter name", () => {
		expect.assertions(1);

		expect(findFormatterOptions(["agent"], "agent")).toStrictEqual({});
	});

	it("should validate and preserve agent options", () => {
		expect.assertions(1);

		expect(findFormatterOptions([["agent", { maxFailures: 3 }]], "agent")).toStrictEqual({
			maxFailures: 3,
		});
	});

	it("should validate and preserve nested GitHub Actions options", () => {
		expect.assertions(1);

		const options = {
			displayAnnotations: false,
			jobSummary: {
				enabled: true,
				fileLinks: {
					commitHash: "abc123",
					repository: "isentinel/halcyon",
					workspacePath: "/repo",
				},
				outputPath: "summary.md",
			},
		};

		expect(findFormatterOptions([["github-actions", options]], "github-actions")).toStrictEqual(
			options,
		);
	});

	it("should reject unknown formatter options", () => {
		expect.assertions(2);

		expect(() => {
			return findFormatterOptions(
				[fromAny<FormatterEntry, unknown>(["agent", { maxFailures: 3, unknown: true }])],
				"agent",
			);
		}).toThrow("unknown must be removed");
		expect(() => {
			return findFormatterOptions(
				[
					fromAny<FormatterEntry, unknown>([
						"github-actions",
						{ jobSummary: { fileLinks: { repository: "repo", unknown: true } } },
					]),
				],
				"github-actions",
			);
		}).toThrow("unknown must be removed");
	});
});

describe(hasFormatter, () => {
	it("should find a named formatter among unrelated entries", () => {
		expect.assertions(2);

		const formatters: Array<FormatterEntry> = ["json", ["agent", { maxFailures: 2 }]];

		expect(hasFormatter(formatters, "agent")).toBeTrue();
		expect(hasFormatter(formatters, "github-actions")).toBeFalse();
	});
});

describe(usesAgentFormatter, () => {
	it("should suppress agent mode only when verbose output is requested", () => {
		expect.assertions(2);

		expect(usesAgentFormatter(["agent"], false)).toBeTrue();
		expect(usesAgentFormatter(["agent"], true)).toBeFalse();
	});
});

describe(isDefaultHumanFormatter, () => {
	const cases: Array<
		[{ formatters?: Array<FormatterEntry>; silent?: boolean; verbose?: boolean }, boolean]
	> = [
		[{ formatters: ["agent"] }, false],
		[{ formatters: ["agent"], verbose: true }, true],
		[{ formatters: ["json"] }, false],
		[{ silent: true }, false],
		[{}, true],
	];

	it.for(cases)("should resolve %j as %j", ([options, expected]) => {
		expect.assertions(1);

		expect(isDefaultHumanFormatter(options)).toBe(expected);
	});
});
