import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { STUDIO_CLI_PROTOCOL_VERSION } from "./studio-cli.ts";
import { STUDIO_PROTOCOL_VERSION } from "./studio.ts";

/**
 * The protocol number is written in four places across two languages, and
 * nothing but this checks that they agree. A drift between them is silent
 * where it happens and surfaces as an "update the plugin" error against a
 * plugin that is already current.
 *
 * Reads the real files rather than a memfs seed: the invariant is about what
 * ships, so a fixture would assert nothing.
 */
function readLuauProtocolVersion(file: string): number {
	const source = fs.readFileSync(new URL(`../../plugin/src/${file}`, import.meta.url), "utf8");
	const match = /^local PROTOCOL_VERSION = (\d+)$/mu.exec(source);
	if (match === null) {
		throw new Error(`no PROTOCOL_VERSION declaration in plugin/src/${file}`);
	}

	return Number(match[1]);
}

describe("protocol version parity", () => {
	it.for(["init.server.luau", "test-in-run-mode.server.luau"])(
		"should declare the CLI's protocol version in %s",
		(file) => {
			expect.assertions(1);

			expect(readLuauProtocolVersion(file)).toBe(STUDIO_PROTOCOL_VERSION);
		},
	);

	it("should use one protocol version across both Studio backends", () => {
		expect.assertions(1);

		expect(STUDIO_CLI_PROTOCOL_VERSION).toBe(STUDIO_PROTOCOL_VERSION);
	});
});
