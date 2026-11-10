import { type } from "arktype";
import { describe, expect, it } from "vitest";

import {
	findGitHubActionsOptions,
	formatterEntriesSchema,
	type FormatterEntry,
	isDefaultHumanFormatter,
	selectTerminalFormatter,
	usesAgentFormatter,
} from "./formatter-selection.ts";

describe(selectTerminalFormatter, () => {
	it.for<
		[Array<FormatterEntry> | undefined, boolean, ReturnType<typeof selectTerminalFormatter>]
	>([
		[["agent"], false, { name: "agent", maxFailures: 10 }],
		[[["agent", { maxFailures: 3 }]], false, { name: "agent", maxFailures: 3 }],
		[["json", "agent"], false, { name: "agent", maxFailures: 10 }],
		[["agent", "json"], true, { name: "json" }],
		[[["json", {}]], false, { name: "json" }],
		[["agent"], true, { name: "default" }],
		[["github-actions"], false, { name: "default" }],
		[undefined, false, { name: "default" }],
	])("should select from %j (verbose %j) as %j", ([formatters, verbose, expected]) => {
		expect.assertions(1);

		expect(selectTerminalFormatter({ formatters, verbose })).toStrictEqual(expected);
	});
});

describe(usesAgentFormatter, () => {
	it("should suppress agent mode only when verbose output is requested", () => {
		expect.assertions(2);

		expect(usesAgentFormatter({ formatters: ["agent"] })).toBeTrue();
		expect(usesAgentFormatter({ formatters: ["agent"], verbose: true })).toBeFalse();
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

describe(findGitHubActionsOptions, () => {
	it("should give empty options for a bare name and the entry's own options for a pair", () => {
		expect.assertions(2);

		expect(findGitHubActionsOptions(["default", "github-actions"])).toStrictEqual({});
		expect(
			findGitHubActionsOptions([["github-actions", { displayAnnotations: false }]]),
		).toStrictEqual({ displayAnnotations: false });
	});

	it("should give undefined when the list does not name it", () => {
		expect.assertions(2);

		expect(findGitHubActionsOptions(["agent"])).toBeUndefined();
		expect(findGitHubActionsOptions(undefined)).toBeUndefined();
	});
});

describe("formatterEntriesSchema", () => {
	it("should accept a formatter name or a name with options", () => {
		expect.assertions(1);

		expect(formatterEntriesSchema(["json", ["agent", {}]])).not.toBeInstanceOf(type.errors);
	});

	it("should accept every formatter's documented options", () => {
		expect.assertions(1);

		expect(
			formatterEntriesSchema([
				["agent", { maxFailures: 3 }],
				[
					"github-actions",
					{
						displayAnnotations: false,
						jobSummary: {
							enabled: true,
							fileLinks: {
								commitHash: "abc",
								repository: "o/r",
								workspacePath: "/repo",
							},
							outputPath: "summary.md",
						},
					},
				],
				["default", {}],
				["json", {}],
			]),
		).not.toBeInstanceOf(type.errors);
	});

	it.for([
		[["fancy"]],
		[[["agent", { maxFailure: 3 }]]],
		[[["agent", { maxFailures: "3" }]]],
		[[["github-actions", { jobSummary: { fileLinks: { repo: "o/r" } } }]]],
		[[["json", { pretty: true }]]],
	])("should reject %j when the config loads", ([entries]) => {
		expect.assertions(1);

		expect(formatterEntriesSchema(entries)).toBeInstanceOf(type.errors);
	});
});
