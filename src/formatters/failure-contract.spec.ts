import { fromPartial } from "@total-typescript/shoehorn";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import color from "tinyrainbow";
import { describe, expect, it, onTestFinished } from "vitest";

import type { SourceMapper } from "../source-mapper/index.ts";
import type { TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import {
	cleanExecErrorMessage,
	formatExecErrorDetail,
	formatFailure,
	parseErrorMessage,
} from "./failure.ts";
import { type ColorFunc, createStyles, type Styles } from "./styles.ts";

function tagged(label: string): ColorFunc {
	return (text) => `<${label}>${text}</${label}>`;
}

function createTaggedStyles(): Styles {
	return {
		...createStyles(false),
		diff: { expected: tagged("expected"), received: tagged("received") },
		dim: tagged("dim"),
		failBadge: tagged("badge"),
		status: {
			fail: tagged("fail"),
			pass: tagged("pass"),
			pending: tagged("pending"),
		},
	};
}

function makeTemporaryFile(content: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-failure-"));
	const filePath = path.join(directory, "example.spec.luau");
	fs.writeFileSync(filePath, content);
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return filePath;
}

describe(parseErrorMessage, () => {
	it("should distinguish snapshots, expected values, and received values exactly", () => {
		expect.assertions(1);

		expect([
			parseErrorMessage("Mismatch\nExpected value:  one\nReceived value: two"),
			parseErrorMessage("Snapshot failed\n- Snapshot - 1\n- old\n+ new\n[string x]:4: trace"),
			parseErrorMessage("Not a snapshot: - Snapshot - 2\nExpected: yes\nReceived: no"),
		]).toStrictEqual([
			{ expected: "one", message: "Mismatch", received: "two" },
			{ message: "Snapshot failed", snapshotDiff: "- Snapshot - 1\n- old\n+ new" },
			{
				expected: "yes",
				message: "Not a snapshot: - Snapshot - 2",
				received: "no",
			},
		]);
	});
});

describe(cleanExecErrorMessage, () => {
	it("should strip only the complete Roblox path chain after the suite header", () => {
		expect.assertions(1);

		expect(
			cleanExecErrorMessage(
				"● Test suite failed to run\n\nReplicatedStorage.pkg.init.spec:12: Workspace.mod-test:3: actual failure\nstack",
			),
		).toBe("actual failure");
	});

	it("should trim a message without a suite header", () => {
		expect.assertions(1);

		expect(cleanExecErrorMessage("  direct failure  ")).toBe("direct failure");
	});
});

describe(formatFailure, () => {
	it("should enable color and omit the file segment by default", () => {
		expect.assertions(3);

		const test = fromPartial<TestCaseResult>({
			ancestorTitles: ["suite"],
			failureMessages: ["Error: mismatch"],
			title: "case",
		});
		const output = formatFailure({ test });
		const plainOutput = formatFailure({ test, useColor: false });

		expect(output).toContain(color.bold("Error:"));
		expect(output).toContain("suite > case");
		expect(plainOutput.split("\n", 2)[1]).toBe("   FAIL  suite > case");
	});

	it("should omit Luau snippets by default", () => {
		expect.assertions(2);

		const luauPath = makeTemporaryFile("return false\n");
		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 1,
							luauPath,
							sourceContent: "throw new Error();\n",
							tsLine: 1,
							tsPath: "src/example.spec.ts",
						},
					],
					message: "Error: mismatch",
				};
			},
		});
		const test = fromPartial<TestCaseResult>({
			ancestorTitles: [],
			failureMessages: ["Error: mismatch"],
			title: "case",
		});
		const output = formatFailure({ sourceMapper, test, useColor: false });

		expect(output).toContain("src/example.spec.ts:1");
		expect(output).not.toContain("(Luau)");
	});

	it.for(["Mismatch\nExpected: one", "Mismatch\nReceived: two"])(
		"should omit a diff when only one comparison value was parsed",
		(failureMessage) => {
			expect.assertions(2);

			const test = fromPartial<TestCaseResult>({
				ancestorTitles: [],
				failureMessages: [failureMessage],
				title: "case",
			});
			const output = formatFailure({ styles: createTaggedStyles(), test, useColor: false });

			expect(output).not.toContain("- Expected");
			expect(output).not.toContain("undefined");
		},
	);

	it("should dim context lines in snapshot diffs", () => {
		expect.assertions(1);

		const test = fromPartial<TestCaseResult>({
			ancestorTitles: [],
			failureMessages: ["Snapshot mismatch\n- Snapshot - 1\n  Object {\n+ added"],
			title: "case",
		});

		expect(formatFailure({ styles: createTaggedStyles(), test, useColor: false })).toContain(
			"<dim>  Object {</dim>",
		);
	});

	it("should not search for a snapshot call for an ordinary failure", () => {
		expect.assertions(1);

		const filePath = makeTemporaryFile("expect(value).toMatchSnapshot();\n");
		const test = fromPartial<TestCaseResult>({
			ancestorTitles: [],
			failureMessages: ["ordinary failure"],
			title: "case",
		});

		expect(formatFailure({ filePath, test, useColor: false })).not.toContain(`❯ ${filePath}:1`);
	});

	it("should render expected/received and snapshot failures completely", () => {
		expect.assertions(2);

		const test = fromPartial<TestCaseResult>({
			ancestorTitles: ["suite"],
			failureMessages: [
				"Error: mismatch\nExpected: one\nReceived: two",
				"Snapshot mismatch\n- Snapshot - 1\n- old\n+ new",
			],
			title: "case",
		});

		expect(
			formatFailure({
				failureIndex: 2,
				filePath: "src/example.spec.ts",
				styles: createTaggedStyles(),
				test,
				totalFailures: 3,
				useColor: false,
			}),
		).toMatchSnapshot("plain");
		expect(
			formatFailure({
				failureIndex: 2,
				filePath: "src/example.spec.ts",
				styles: createTaggedStyles(),
				test,
				totalFailures: 3,
				useColor: true,
			}),
		).toMatchSnapshot("colored");
	});
});

describe(formatExecErrorDetail, () => {
	it("should render the cleaned failure, hint, separator, and counter update", () => {
		expect.assertions(2);

		const failureContext = { currentIndex: 1, totalFailures: 2 };
		const file = fromPartial<TestFileResult>({
			failureMessage:
				"● Test suite failed to run\nReplicatedStorage.pkg:init.spec:12: loadstring() is not available",
			testFilePath: "src/init.spec.ts",
		});

		expect(formatExecErrorDetail(file, createStyles(false), failureContext)).toMatchSnapshot();
		expect(failureContext.currentIndex).toBe(2);
	});

	it("should preserve an unstyled blank line inside a multiline message", () => {
		expect.assertions(2);

		const failureContext = { currentIndex: 1, totalFailures: 1 };
		const file = fromPartial<TestFileResult>({
			failureMessage: "first line\n\nsecond line",
			testFilePath: "src/init.spec.ts",
		});
		const output = formatExecErrorDetail(file, createTaggedStyles(), failureContext);

		expect(output).toContain("  <fail>first line</fail>\n\n  <fail>second line</fail>");
		expect(output).not.toContain("<fail></fail>");
	});
});
