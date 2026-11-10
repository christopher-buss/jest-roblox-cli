import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readHarness, spawnHarness } from "#test/luau/lute-harness.ts";

const REPOSITORY_DIRECTORY = path.resolve(import.meta.dirname, "../..");
const PLUGIN_SOURCE = fs.readFileSync(
	path.join(REPOSITORY_DIRECTORY, "plugin/src/test-in-run-mode.server.luau"),
	"utf8",
);
const HARNESS_SOURCE = readHarness("plugin-session-ownership");

function moduleFactories(): string {
	const visited = new Set<string>();
	const factories: Array<string> = [];
	function visit(modulePath: string): void {
		if (visited.has(modulePath)) {
			return;
		}

		visited.add(modulePath);
		const source = fs.readFileSync(
			path.join(REPOSITORY_DIRECTORY, "luau", `${modulePath}.luau`),
			"utf8",
		);
		const imports: Array<string> = [];
		for (const match of source.matchAll(/require\("(\.[^"]+)"\)/gu)) {
			const importPath = match[1]!;
			const dependencyPath = path.posix.normalize(
				path.posix.join(path.posix.dirname(modulePath), importPath),
			);
			visit(dependencyPath);
			imports.push(`[${JSON.stringify(importPath)}] = ${JSON.stringify(dependencyPath)}`);
		}

		factories.push(`factories[${JSON.stringify(modulePath)}] = function()
local imports = { ${imports.join(", ")} }
local require = function(request) return loadModule(imports[request] or request) end
${source}
end`);
	}

	visit("envelope");
	visit("protocol");
	visit("vm-parallel");
	visit("staging/embedded-runner");
	return factories.join("\n");
}

const MODULE_FACTORIES = moduleFactories();

const MARKED_WORKSPACE_REQUEST =
	"{ test = true, protocolVersion = 12, workspace = { entries = {} } }";

interface RunState {
	edit?: boolean;
	runningAfter?: number;
}

interface SessionOptions {
	assertion: string;
	request: string;
	runState?: RunState;
	sideChannelPayload?: string;
}

function luauRunState({ edit = false, runningAfter = 0 }: RunState): string {
	const after = runningAfter === Infinity ? "math.huge" : runningAfter.toString();
	return `{ edit = ${edit.toString()}, runningAfter = ${after} }`;
}

function runSession({
	assertion,
	request,
	runState = {},
	sideChannelPayload = "nil",
}: SessionOptions): string {
	return spawnHarness(
		"plugin-session-ownership-",
		HARNESS_SOURCE.replace("__REQUEST__", () => request)
			.replace("__SIDE_CHANNEL_PAYLOAD__", () => sideChannelPayload)
			.replace("__RUN_STATE__", () => luauRunState(runState))
			.replace("__MODULES__", () => MODULE_FACTORIES)
			.replace("__PLUGIN__", () => PLUGIN_SOURCE)
			.replace("__ASSERTION__", () => assertion),
	);
}

describe("studio plugin session ownership", () => {
	it("should leave an unmarked nativeAudit session to its caller", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: 'assert(#results == 0, "Unmarked nativeAudit session called EndTest")',
				request: '{ nativeAudit = "request-123" }',
			}),
		).toContain("ALL OK");
	});

	it("should ignore an unmarked session even when its protocol matches", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion:
					'assert(#results == 0, "Unmarked matching-protocol session called EndTest")',
				request: "{ protocolVersion = 12 }",
			}),
		).toContain("ALL OK");
	});

	it("should ignore scalar session arguments", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: 'assert(#results == 0, "Scalar session called EndTest")',
				request: "42",
			}),
		).toContain("ALL OK");
	});

	it("should ignore a session whose test marker is false", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: 'assert(#results == 0, "False-marker session called EndTest")',
				request: "{ test = false, protocolVersion = 12 }",
			}),
		).toContain("ALL OK");
	});

	it("should ignore a session whose test marker is a truthy string", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: 'assert(#results == 0, "String-marker session called EndTest")',
				request: '{ test = "true", protocolVersion = 12 }',
			}),
		).toContain("ALL OK");
	});

	it("should reject a marked session missing its protocol version", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 1, "Marked missing-protocol session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "protocol version mismatch", 1, true), output.err)`,
				request: "{ test = true }",
			}),
		).toContain("ALL OK");
	});

	it("should reject a marked session with a mismatched protocol version", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 1, "Marked mismatched-protocol session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "CLI v9", 1, true), output.err)`,
				request: "{ test = true, protocolVersion = 9 }",
			}),
		).toContain("ALL OK");
	});

	it("should reject a marked session asking for a different plugin key", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 1, "Marked mismatched-key session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "plugin key mismatch", 1, true), output.err)`,
				request:
					'{ test = true, protocolVersion = 12, pluginKey = "another-installed-plugin" }',
			}),
		).toContain("ALL OK");
	});

	it("should return an embedded workspace result for a marked session", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 1, "Marked workspace session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.entries ~= nil and #output.entries == 0 and output.bailed == nil and output.deferred == nil,
    output.err or "Expected an empty workspace result")`,
				request: MARKED_WORKSPACE_REQUEST,
			}),
		).toContain("ALL OK");
	});

	it("should ignore an unmarked payload recovered through the nil relay", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion:
					'assert(#results == 0 and #relayedResults == 0, "Unmarked nil-relay payload ended the session")',
				request: "nil",
				sideChannelPayload: '{ nativeAudit = "request-123", protocolVersion = 12 }',
			}),
		).toContain("ALL OK");
	});

	it("should leave the socket to the copy a recovered payload asks for", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion:
					'assert(socketsOpened == 0, "A copy with another key opened the studio-cli socket")',
				request: "nil",
				sideChannelPayload:
					'{ test = true, protocolVersion = 12, pluginKey = "another-installed-plugin" }',
			}),
		).toContain("ALL OK");
	});

	it("should relay an embedded workspace result for a recovered marked payload", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 0 and #relayedResults == 1, "Marked nil-relay payload must return through the socket")
local frame = relayedResults[1]
local output = HttpService:JSONDecode(frame.jestOutput)
assert(frame.requestId == "request-123" and output.entries ~= nil and #output.entries == 0,
    output.err or "Expected a relayed workspace result")`,
				request: "nil",
				sideChannelPayload: MARKED_WORKSPACE_REQUEST,
			}),
		).toContain("ALL OK");
	});

	it("should run a marked session whose play server starts running after the plugin", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 1, "A session that started running late must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.entries ~= nil and #output.entries == 0, output.err or "Expected an empty workspace result")`,
				request: MARKED_WORKSPACE_REQUEST,
				runState: { runningAfter: 1.5 },
			}),
		).toContain("ALL OK");
	});

	it("should stay out of the edit data model", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion:
					'assert(#results == 0 and testArgsReads == 0, "The edit data model read the test arguments")',
				request: MARKED_WORKSPACE_REQUEST,
				runState: { edit: true, runningAfter: Infinity },
			}),
		).toContain("ALL OK");
	});

	it("should warn when the play server of a studio-cli run never starts running", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion: `assert(#results == 0 and testArgsReads == 0 and socketsOpened == 0, "A session that never ran went on")
assert(#warnings == 1 and string.find(warnings[1], "did not start running", 1, true), "A copy that gave up said nothing")
table.clear(warnings)`,
				request: MARKED_WORKSPACE_REQUEST,
				runState: { runningAfter: Infinity },
				sideChannelPayload: MARKED_WORKSPACE_REQUEST,
			}),
		).toContain("ALL OK");
	});

	it("should give up quietly on a play server outside a studio-cli run that never starts running", () => {
		expect.assertions(1);

		expect(
			runSession({
				assertion:
					'assert(#results == 0 and testArgsReads == 0, "A session that never ran read the test arguments")',
				request: MARKED_WORKSPACE_REQUEST,
				runState: { runningAfter: Infinity },
			}),
		).toContain("ALL OK");
	});
});
