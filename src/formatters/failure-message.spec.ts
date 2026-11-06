import { describe, expect, it } from "vitest";

import { cleanExecErrorMessage, getExecErrorHint, parseErrorMessage } from "./failure-message.ts";

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
