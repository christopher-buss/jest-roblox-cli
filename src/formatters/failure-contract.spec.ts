import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

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
});

describe(formatFailure, () => {
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
});
