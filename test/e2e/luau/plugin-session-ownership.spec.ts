import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { LUTE_HARNESS_TIMEOUT } from "#test/e2e/luau/lute-timeout.ts";

const REPOSITORY_DIRECTORY = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_SOURCE = fs.readFileSync(
	path.join(REPOSITORY_DIRECTORY, "plugin/src/test-in-run-mode.server.luau"),
	"utf8",
);
const HARNESS_SOURCE = fs.readFileSync(
	path.join(import.meta.dirname, "plugin-session-ownership.harness.luau"),
	"utf8",
);

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

	visit("vm-parallel");
	visit("staging/embedded-runner");
	return factories.join("\n");
}

const MODULE_FACTORIES = moduleFactories();

function runSession(request: string, assertion: string, sideChannelPayload = "nil"): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-session-ownership-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	const scriptPath = path.join(directory, "harness.luau");
	fs.writeFileSync(
		scriptPath,
		HARNESS_SOURCE.replace("__REQUEST__", () => request)
			.replace("__SIDE_CHANNEL_PAYLOAD__", () => sideChannelPayload)
			.replace("__MODULES__", () => MODULE_FACTORIES)
			.replace("__PLUGIN__", () => PLUGIN_SOURCE)
			.replace("__ASSERTION__", () => assertion),
	);
	return spawnLute({ args: [], scriptPath });
}

describe("studio plugin session ownership", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should leave an unmarked nativeAudit session to its caller", () => {
		expect.assertions(1);

		expect(
			runSession(
				'{ nativeAudit = "request-123" }',
				'assert(#results == 0, "Unmarked nativeAudit session called EndTest")',
			),
		).toContain("ALL OK");
	});

	it("should ignore an unmarked session even when its protocol matches", () => {
		expect.assertions(1);

		expect(
			runSession(
				"{ protocolVersion = 10 }",
				'assert(#results == 0, "Unmarked matching-protocol session called EndTest")',
			),
		).toContain("ALL OK");
	});

	it("should ignore scalar session arguments", () => {
		expect.assertions(1);

		expect(
			runSession("42", 'assert(#results == 0, "Scalar session called EndTest")'),
		).toContain("ALL OK");
	});

	it("should ignore a session whose test marker is false", () => {
		expect.assertions(1);

		expect(
			runSession(
				"{ test = false, protocolVersion = 10 }",
				'assert(#results == 0, "False-marker session called EndTest")',
			),
		).toContain("ALL OK");
	});

	it("should ignore a session whose test marker is a truthy string", () => {
		expect.assertions(1);

		expect(
			runSession(
				'{ test = "true", protocolVersion = 10 }',
				'assert(#results == 0, "String-marker session called EndTest")',
			),
		).toContain("ALL OK");
	});

	it("should reject a marked session missing its protocol version", () => {
		expect.assertions(1);

		expect(
			runSession(
				"{ test = true }",
				`assert(#results == 1, "Marked missing-protocol session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "protocol version mismatch", 1, true), output.err)`,
			),
		).toContain("ALL OK");
	});

	it("should reject a marked session with a mismatched protocol version", () => {
		expect.assertions(1);

		expect(
			runSession(
				"{ test = true, protocolVersion = 9 }",
				`assert(#results == 1, "Marked mismatched-protocol session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "CLI v9", 1, true), output.err)`,
			),
		).toContain("ALL OK");
	});

	it("should reject a marked session asking for a different plugin key", () => {
		expect.assertions(1);

		expect(
			runSession(
				'{ test = true, protocolVersion = 10, pluginKey = "another-installed-plugin" }',
				`assert(#results == 1, "Marked mismatched-key session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.success == false and string.find(output.err, "plugin key mismatch", 1, true), output.err)`,
			),
		).toContain("ALL OK");
	});

	it("should return an embedded workspace result for a marked session", () => {
		expect.assertions(1);

		expect(
			runSession(
				"{ test = true, protocolVersion = 10, workspace = { entries = {} } }",
				`assert(#results == 1, "Marked workspace session must end")
local output = HttpService:JSONDecode(results[1].jestOutput)
assert(output.entries ~= nil and #output.entries == 0 and output.bailed == false and output.deferred == false,
    output.err or "Expected an empty workspace result")`,
			),
		).toContain("ALL OK");
	});

	it("should ignore an unmarked payload recovered through the nil relay", () => {
		expect.assertions(1);

		expect(
			runSession(
				"nil",
				'assert(#results == 0 and #relayedResults == 0, "Unmarked nil-relay payload ended the session")',
				'{ nativeAudit = "request-123", protocolVersion = 10 }',
			),
		).toContain("ALL OK");
	});

	it("should leave the socket to the copy a recovered payload asks for", () => {
		expect.assertions(1);

		expect(
			runSession(
				"nil",
				'assert(socketsOpened == 0, "A copy with another key opened the studio-cli socket")',
				'{ test = true, protocolVersion = 10, pluginKey = "another-installed-plugin" }',
			),
		).toContain("ALL OK");
	});

	it("should relay an embedded workspace result for a recovered marked payload", () => {
		expect.assertions(1);

		expect(
			runSession(
				"nil",
				`assert(#results == 0 and #relayedResults == 1, "Marked nil-relay payload must return through the socket")
local frame = relayedResults[1]
local output = HttpService:JSONDecode(frame.jestOutput)
assert(frame.requestId == "request-123" and output.entries ~= nil and #output.entries == 0,
    output.err or "Expected a relayed workspace result")`,
				"{ test = true, protocolVersion = 10, workspace = { entries = {} } }",
			),
		).toContain("ALL OK");
	});
});
