import { fromPartial } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import color from "tinyrainbow";
import { describe, expect, it, vi } from "vitest";

import { createPlainStyles } from "#test/mocks/format-plain-styles.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TestCaseResult, TestFileResult } from "../types/jest-result-types.ts";
import {
	cleanExecErrorMessage,
	formatExecErrorDetail,
	formatFailure,
	formatFileFailures,
	getExecErrorHint,
	parseErrorMessage,
} from "./failure.ts";
import type { ColorFunc, Styles } from "./styles.ts";

function tagged(label: string): ColorFunc {
	return (text) => `<${label}>${text}</${label}>`;
}

function createTaggedStyles(): Styles {
	return {
		...createPlainStyles(),
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

function makeSourceFile(content: string) {
	const filePath = path.resolve("example.spec.luau");
	const { fileSystem } = createMemoryFileSystem({ [filePath]: content });
	return { filePath, fileSystem };
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

		const { filePath: luauPath, fileSystem } = makeSourceFile("return false\n");
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
		const output = formatFailure({ fileSystem, sourceMapper, test, useColor: false });

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

		const { filePath, fileSystem } = makeSourceFile("expect(value).toMatchSnapshot();\n");
		const test = fromPartial<TestCaseResult>({
			ancestorTitles: [],
			failureMessages: ["ordinary failure"],
			title: "case",
		});

		expect(formatFailure({ filePath, fileSystem, test, useColor: false })).not.toContain(
			`❯ ${filePath}:1`,
		);
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

		expect(
			formatExecErrorDetail({
				failureCtx: failureContext,
				file,
				styles: createPlainStyles(),
			}),
		).toMatchSnapshot();
		expect(failureContext.currentIndex).toBe(2);
	});

	it("should badge a timed-out file as a timeout rather than a failure", () => {
		expect.assertions(1);

		const file = fromPartial<TestFileResult>({
			failureMessage: "Timed out",
			testFilePath: "src/init.spec.ts",
			timedOut: true,
		});

		expect(
			formatExecErrorDetail({
				failureCtx: { currentIndex: 1, totalFailures: 1 },
				file,
				styles: createTaggedStyles(),
			}),
		).toContain(" TIMEOUT ");
	});

	it("should preserve an unstyled blank line inside a multiline message", () => {
		expect.assertions(2);

		const failureContext = { currentIndex: 1, totalFailures: 1 };
		const file = fromPartial<TestFileResult>({
			failureMessage: "first line\n\nsecond line",
			testFilePath: "src/init.spec.ts",
		});
		const output = formatExecErrorDetail({
			failureCtx: failureContext,
			file,
			styles: createTaggedStyles(),
		});

		expect(output).toContain("  <fail>first line</fail>\n\n  <fail>second line</fail>");
		expect(output).not.toContain("<fail></fail>");
	});
});

describe(formatFileFailures, () => {
	it("should number only failed tests and advance the shared counter", () => {
		expect.assertions(3);

		const failureContext = { currentIndex: 3, totalFailures: 4 };
		const file = fromPartial<TestFileResult>({
			testFilePath: "src/example.spec.ts",
			testResults: [
				fromPartial<TestCaseResult>({
					ancestorTitles: [],
					failureMessages: [],
					status: "passed",
					title: "passes",
				}),
				fromPartial<TestCaseResult>({
					ancestorTitles: [],
					failureMessages: ["first failure"],
					status: "failed",
					title: "fails once",
				}),
				fromPartial<TestCaseResult>({
					ancestorTitles: [],
					failureMessages: ["second failure"],
					status: "failed",
					title: "fails twice",
				}),
			],
		});
		const output = formatFileFailures({
			failureCtx: failureContext,
			file,
			options: { color: false, rootDir: "/repo", verbose: false, version: "1.0.0" },
			styles: createPlainStyles(),
		});

		expect(output).toContain("[3/4]");
		expect(output).not.toContain("passes");
		expect(failureContext.currentIndex).toBe(5);
	});
});

describe(parseErrorMessage, () => {
	it("should extract expected and received values", () => {
		expect.assertions(3);

		const message = `expect(received).toBe(expected) -- Object.is equality

Expected: 5
Received: 4`;

		const parsed = parseErrorMessage(message);

		expect(parsed.message).toBe("expect(received).toBe(expected) -- Object.is equality");
		expect(parsed.expected).toBe("5");
		expect(parsed.received).toBe("4");
	});

	it("should handle messages without expected/received", () => {
		expect.assertions(3);

		const message = "Some generic error occurred";

		const parsed = parseErrorMessage(message);

		expect(parsed.message).toBe("Some generic error occurred");
		expect(parsed.expected).toBeUndefined();
		expect(parsed.received).toBeUndefined();
	});

	it("should extract complex expected/received values", () => {
		expect.assertions(2);

		const message = `Expected: {"name": "test"}
Received: {"name": "other"}`;

		const parsed = parseErrorMessage(message);

		expect(parsed.expected).toBe('{"name": "test"}');
		expect(parsed.received).toBe('{"name": "other"}');
	});

	it("should extract snapshot diff from failure message", () => {
		expect.assertions(1);

		const message = [
			"expect(received).toMatchSnapshot()",
			"",
			"Snapshot name: `trait data > Apex matches snapshot 1`",
			"",
			"- Snapshot  - 2",
			"+ Received  + 2",
			"",
			"  Object {",
			'    "name": "Apex",',
			'-   "health": 100,',
			'-   "speed": 50,',
			'+   "health": 150,',
			'+   "speed": 75,',
			"  }",
			"",
			'[string "ReplicatedStorage.traits.spec"]:41',
		].join("\n");

		const parsed = parseErrorMessage(message);

		expect(parsed.snapshotDiff).toBe(
			[
				"- Snapshot  - 2",
				"+ Received  + 2",
				"",
				"  Object {",
				'    "name": "Apex",',
				'-   "health": 100,',
				'-   "speed": 50,',
				'+   "health": 150,',
				'+   "speed": 75,',
				"  }",
			].join("\n"),
		);
	});

	it("should not set expected/received for snapshot failures", () => {
		expect.assertions(2);

		const message = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "health": 100,',
			'+   "health": 150,',
		].join("\n");

		const parsed = parseErrorMessage(message);

		expect(parsed.expected).toBeUndefined();
		expect(parsed.received).toBeUndefined();
	});

	it("should extract values from toThrow with labeled expected/received", () => {
		expect.assertions(1);

		const message = `expect(received).toThrow(expected)

Expected substring: ".pass"
Received value:     "some error message"`;

		const parsed = parseErrorMessage(message);

		expect(parsed).toStrictEqual({
			expected: '".pass"',
			message: "expect(received).toThrow(expected)",
			received: '"some error message"',
		});
	});
});

describe(formatFailure, () => {
	it("should format test failure with vitest-style diff", () => {
		expect.assertions(5);

		const test: TestCaseResult = {
			ancestorTitles: ["Player"],
			duration: 10,
			failureMessages: ["expect(received).toBe(expected)\n\nExpected: 100\nReceived: 0"],
			fullName: "Player should have health",
			status: "failed",
			title: "should have health",
		};

		const formatted = formatFailure({ filePath: "src/player.spec.ts", test });

		expect(formatted).toContain("FAIL");
		expect(formatted).toContain("src/player.spec.ts > Player > should have health");
		expect(formatted).toContain("- Expected");
		expect(formatted).toContain("+ Received");
		expect(formatted).toContain("- 100");
	});

	it("should format failure with file path and ancestors", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: ["Math", "Addition"],
			duration: 5,
			failureMessages: ["Expected: 5\nReceived: 4"],
			fullName: "Math Addition should add",
			status: "failed",
			title: "should add",
		};

		const formatted = formatFailure({ filePath: "test.spec.ts", test });

		expect(formatted).toContain("test.spec.ts > Math > Addition > should add");
	});

	it("should render snapshot diff with unified format", () => {
		expect.assertions(3);

		const test: TestCaseResult = {
			ancestorTitles: ["trait data"],
			duration: 12,
			failureMessages: [
				[
					"expect(received).toMatchSnapshot()",
					"",
					"- Snapshot  - 1",
					"+ Received  + 1",
					"",
					'-   "health": 100,',
					'+   "health": 150,',
					"",
					'[string "ReplicatedStorage.traits.spec"]:41',
				].join("\n"),
			],
			fullName: "trait data Apex matches snapshot",
			status: "failed",
			title: "Apex matches snapshot",
		};

		const formatted = formatFailure({
			filePath: "src/traits.spec.ts",
			test,
			useColor: false,
		});

		expect(formatted).toContain("- Snapshot  - 1");
		expect(formatted).toContain("+ Received  + 1");
		expect(formatted).toContain('-   "health": 100,');
	});

	it("should not include mapped source location inside snapshot diff", () => {
		expect.assertions(3);

		const sourceContent = Array.from({ length: 31 }, (_, index) => `line ${index + 1}`);
		sourceContent[28] = "expect(player).toMatchSnapshot();";

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 41,
							luauPath: "out/traits.spec.luau",
							sourceContent: sourceContent.join("\n"),
							tsColumn: 16,
							tsLine: 29,
							tsPath: "src/traits.spec.ts",
						},
					],
					message: [
						"expect(received).toMatchSnapshot()",
						"",
						"- Snapshot - 1",
						"+ Received + 1",
						"",
						'- "health": 100,',
						'+ "health": 150,',
						"",
						"src/traits.spec.ts:29",
					].join("\n"),
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: ["trait data"],
			duration: 12,
			failureMessages: [
				[
					"expect(received).toMatchSnapshot()",
					"",
					"- Snapshot  - 1",
					"+ Received  + 1",
					"",
					'-   "health": 100,',
					'+   "health": 150,',
					"",
					'[string "ReplicatedStorage.traits.spec"]:41',
				].join("\n"),
			],
			fullName: "trait data Apex matches snapshot",
			status: "failed",
			title: "Apex matches snapshot",
		};

		const formatted = formatFailure({ sourceMapper, test, useColor: false });

		expect(formatted).toContain("❯ src/traits.spec.ts:29:16");
		expect(formatted).toContain("- Snapshot  - 1");
		expect(formatted.match(/src\/traits\.spec\.ts:29/g)!).toHaveLength(1);
	});

	it("should show Luau snippet for Luau-only mapped location", () => {
		expect.assertions(3);

		const luauFile = path.resolve("test.spec.luau");
		const { fileSystem } = createMemoryFileSystem({
			[luauFile]: "line1\nline2\nline3\nline4\nexpect(x).toBe(1)\nline6",
		});

		const luauOnlyResult = {
			locations: [{ luauLine: 5, luauPath: luauFile }],
			message: `${luauFile}:5`,
		};
		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => luauOnlyResult,
		});

		const test: TestCaseResult = {
			ancestorTitles: ["Suite"],
			duration: 10,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "Suite should work",
			status: "failed",
			title: "should work",
		};

		const formatted = formatFailure({
			fileSystem,
			sourceMapper,
			test,
			useColor: false,
		});

		expect(formatted).toContain(`❯ ${luauFile}:5`);
		expect(formatted).not.toContain("(TypeScript)");
		expect(formatted).not.toContain("(Luau)");
	});

	it("should format multiple failure messages", () => {
		expect.assertions(2);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: undefined,
			failureMessages: ["Error 1", "Error 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test });

		expect(formatted).toContain("Error 1");
		expect(formatted).toContain("Error 2");
	});
});

describe(cleanExecErrorMessage, () => {
	it("should extract error from Jest failureMessage with path chain", () => {
		expect.assertions(1);

		const raw =
			"  \u25cf Test suite failed to run\n\n    ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183: ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1951: Require-by-string is not enabled for use inside Jest at this time.\n\n      ReplicatedStorage.rbxts_include.node_modules.@rbxts-js.JestRuntime:1183 function requireModule\n";

		expect(cleanExecErrorMessage(raw)).toBe(
			"Require-by-string is not enabled for use inside Jest at this time.",
		);
	});

	it("should extract error from simple failureMessage", () => {
		expect.assertions(1);

		const raw =
			"  \u25cf Test suite failed to run\n\n    Require-by-string is not enabled for use inside Jest at this time.\n";

		expect(cleanExecErrorMessage(raw)).toBe(
			"Require-by-string is not enabled for use inside Jest at this time.",
		);
	});

	it("should return trimmed message when no pattern matches", () => {
		expect.assertions(1);

		expect(cleanExecErrorMessage("Some unexpected error")).toBe("Some unexpected error");
	});

	it("should handle empty string", () => {
		expect.assertions(1);

		expect(cleanExecErrorMessage("")).toBe("");
	});
});

describe("formatErrorLine bold Error: branch", () => {
	it("should bold 'Error:' prefix when useColor is true and message starts with Error:", () => {
		expect.assertions(2);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Error: something went wrong"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: true });
		const plain = stripVTControlCharacters(formatted);

		expect(plain).toContain("Error: something went wrong");
		// With color on, the raw output should differ from stripped (ANSI
		// present)
		expect(formatted).not.toBe(plain);
	});

	it("should not bold when message does not start with Error:", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["expect(received).toBe(expected)"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: false });

		expect(formatted).toContain("expect(received).toBe(expected)");
	});
});

describe("resolveSourceSnippets snapshot-diff fallback", () => {
	it("should attempt snapshot call snippet when snapshot diff present and no mapped locations", () => {
		expect.assertions(2);

		const snapshotMessage = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "health": 100,',
			'+   "health": 150,',
			"",
			'[string "ReplicatedStorage.traits.spec"]:41',
		].join("\n");

		const test: TestCaseResult = {
			ancestorTitles: ["suite"],
			duration: 5,
			failureMessages: [snapshotMessage],
			fullName: "suite snap test",
			status: "failed",
			title: "snap test",
		};

		// filePath provided but nonexistent, no sourceMapper — exercises the
		// hasSnapshotDiff && filePath !== undefined fallback
		// (formatSnapshotCallSnippet returns [] because file doesn't exist)
		const formatted = formatFailure({
			filePath: "nonexistent/path.spec.ts",
			test,
			useColor: false,
		});

		expect(formatted).toContain("- Snapshot  - 1");
		// No source snippet should appear (file doesn't exist)
		expect(formatted).not.toContain("❯");
	});

	it("should use sourceMapper.resolveTestFilePath for snapshot call snippet lookup", () => {
		expect.assertions(1);

		const resolveTestFilePath = vi
			.fn<(p: string) => string>()
			.mockReturnValue("also-nonexistent.spec.ts");
		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: (message: string) => ({ locations: [], message }),
			resolveTestFilePath,
		});

		const snapshotMessage = [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "x": 1,',
			'+   "x": 2,',
			"",
			'[string "RS.test"]:10',
		].join("\n");

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: [snapshotMessage],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		formatFailure({
			filePath: "src/test.spec.ts",
			sourceMapper,
			test,
			useColor: false,
		});

		expect(resolveTestFilePath).toHaveBeenCalledWith("src/test.spec.ts");
	});
});

describe("formatSnapshotCallSnippet via formatFailure", () => {
	function makeTypeScriptFile(content: string) {
		const filePath = path.resolve("formatter-test.ts");
		const { fileSystem } = createMemoryFileSystem({ [filePath]: content });
		return { filePath, fileSystem };
	}

	function makeSnapshotMessage(): string {
		return [
			"expect(received).toMatchSnapshot()",
			"",
			"- Snapshot  - 1",
			"+ Received  + 1",
			"",
			'-   "x": 1,',
			'+   "x": 2,',
			"",
			'[string "RS.test"]:10',
		].join("\n");
	}

	it("should show snapshot call snippet when file exists with exactly one toMatchSnapshot", () => {
		expect.assertions(2);

		const { filePath, fileSystem } = makeTypeScriptFile(
			[
				"import { describe, it, expect } from 'vitest';",
				"",
				"describe('suite', () => {",
				"  it('should match', () => {",
				"    expect(data).toMatchSnapshot();",
				"  });",
				"});",
			].join("\n"),
		);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: [makeSnapshotMessage()],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			filePath,
			fileSystem,
			test,
			useColor: false,
		});

		expect(formatted).toContain(`❯ ${filePath}:5`);
		expect(formatted).toContain("toMatchSnapshot");
	});

	it("should not show snippet when file has multiple toMatchSnapshot calls", () => {
		expect.assertions(1);

		const { filePath, fileSystem } = makeTypeScriptFile(
			["expect(a).toMatchSnapshot();", "expect(b).toMatchSnapshot();"].join("\n"),
		);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: [makeSnapshotMessage()],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			filePath,
			fileSystem,
			test,
			useColor: false,
		});

		// Multiple toMatchSnapshot calls — no snippet shown
		expect(formatted).not.toContain("❯");
	});
});

describe("showLuau mapped location snippets", () => {
	it("should show both TypeScript and Luau snippets when showLuau is true", () => {
		expect.assertions(3);

		const luauContent = Array.from({ length: 15 }, (_, index) => `-- line ${index + 1}`);
		luauContent[9] = "expect(value).toBe(42)";
		const luauFile = path.resolve("formatter-test.luau");
		const { fileSystem } = createMemoryFileSystem({ [luauFile]: luauContent.join("\n") });

		const sourceContent = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		sourceContent[4] = "expect(value).toBe(42);";

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 10,
							luauPath: luauFile,
							sourceContent: sourceContent.join("\n"),
							tsColumn: 15,
							tsLine: 5,
							tsPath: "src/test.ts",
						},
					],
					message: "Expected: 42\nReceived: 0\n\nsrc/test.ts:5",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 42\nReceived: 0"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			fileSystem,
			showLuau: true,
			sourceMapper,
			test,
			useColor: false,
		});

		expect(formatted).toContain("(TypeScript)");
		expect(formatted).toContain("(Luau)");
		expect(formatted).toContain("❯ src/test.ts:5:15");
	});
});

describe("formatFallbackSnippet via formatFailure", () => {
	it("should show fallback snippet when message contains a parseable source location", () => {
		expect.assertions(2);

		const fileContent = [
			"import { describe, it, expect } from 'vitest';",
			"",
			"describe('math', () => {",
			"  it('should add', () => {",
			"    expect(1 + 1).toBe(3);",
			"  });",
			"});",
		].join("\n");
		const temporaryFile = path.join("src", "formatters", "fallback-fixture.ts");
		const { fileSystem } = createMemoryFileSystem({ [temporaryFile]: fileContent });

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: [`LoadModule error: ${temporaryFile}:5:10`],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ fileSystem, test, useColor: false });

		expect(formatted).toContain(`❯ ${temporaryFile}:5:10`);
		expect(formatted).toContain("expect(1 + 1).toBe(3)");
	});
});

describe("formatFallbackSnippet nonexistent file", () => {
	it("should return no snippet when parseSourceLocation matches but file does not exist", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Error at /nonexistent/path/to/file.ts:10:5"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ test, useColor: false });

		// parseSourceLocation parses the location but getSourceSnippet returns
		// undefined because the file doesn't exist — no snippet rendered
		expect(formatted).not.toContain("❯");
	});
});

describe("formatMappedLocationSnippets undefined branches", () => {
	it("should skip TS snippet when tsPath points to nonexistent file", () => {
		expect.assertions(2);

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 5,
							luauPath: "/nonexistent/luau.luau",
							tsLine: 10,
							tsPath: "/nonexistent/source.ts",
						},
					],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			sourceMapper,
			test,
			useColor: false,
		});

		// No snippet rendered for either TS or Luau (both nonexistent)
		expect(formatted).not.toContain("❯");
		expect(formatted).toContain("Expected: 1");
	});

	it("should skip Luau-only snippet when luauPath points to nonexistent file", () => {
		expect.assertions(1);

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [{ luauLine: 5, luauPath: "/nonexistent/luau.luau" }],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({ sourceMapper, test, useColor: false });

		// No snippet rendered — source file nonexistent and no sourceContent
		expect(formatted).not.toContain("❯");
	});

	it("should skip Luau snippet when luauPath points to nonexistent file with showLuau", () => {
		expect.assertions(2);

		const tsContent = Array.from({ length: 10 }, (_, index) => `// line ${index + 1}`);
		tsContent[4] = "expect(x).toBe(1);";

		const sourceMapper = fromPartial<SourceMapper>({
			mapFailureWithLocations: () => {
				return {
					locations: [
						{
							luauLine: 5,
							luauPath: "/nonexistent/luau.luau",
							sourceContent: tsContent.join("\n"),
							tsLine: 5,
							tsPath: "src/real.ts",
						},
					],
					message: "Expected: 1\nReceived: 2",
				};
			},
		});

		const test: TestCaseResult = {
			ancestorTitles: [],
			duration: 1,
			failureMessages: ["Expected: 1\nReceived: 2"],
			fullName: "test",
			status: "failed",
			title: "test",
		};

		const formatted = formatFailure({
			showLuau: true,
			sourceMapper,
			test,
			useColor: false,
		});

		// TS snippet shown (from sourceContent), but Luau snippet skipped
		expect(formatted).toContain("(TypeScript)");
		expect(formatted).not.toContain("(Luau)");
	});
});

describe(getExecErrorHint, () => {
	it("should return hint for loadstring error", () => {
		expect.assertions(1);

		const hint = getExecErrorHint("loadstring() is not available");

		expect(hint).toContain("LoadStringEnabled");
	});

	it("should return undefined for unrecognized errors", () => {
		expect.assertions(1);

		const hint = getExecErrorHint("some other error");

		expect(hint).toBeUndefined();
	});
});

describe("complete formatter contracts", () => {
	it("should render an expected/received failure exactly", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: ["inventory", "stacking"],
			duration: 12,
			failureMessages: [
				"expect(received).toStrictEqual(expected)\n\nExpected: { count: 2 }\nReceived: { count: 1 }",
			],
			fullName: "inventory stacking should merge items",
			status: "failed",
			title: "should merge items",
		};

		expect(
			formatFailure({
				failureIndex: 2,
				filePath: "src/inventory.spec.ts",
				test,
				totalFailures: 3,
				useColor: false,
			}),
		).toMatchSnapshot();
	});

	it("should render a snapshot diff exactly", () => {
		expect.assertions(1);

		const test: TestCaseResult = {
			ancestorTitles: ["inventory"],
			duration: 12,
			failureMessages: [
				[
					"expect(received).toMatchSnapshot()",
					"",
					"- Snapshot  - 1",
					"+ Received  + 1",
					"",
					'-   "count": 2,',
					'+   "count": 1,',
					"",
					'[string "ReplicatedStorage.inventory.spec"]:41',
				].join("\n"),
			],
			fullName: "inventory matches snapshot",
			status: "failed",
			title: "matches snapshot",
		};

		expect(
			formatFailure({ filePath: "src/inventory.spec.ts", test, useColor: false }),
		).toMatchSnapshot();
	});
});
