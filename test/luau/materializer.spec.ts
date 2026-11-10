import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	inlineModule,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/luau/lute-harness.ts";

// Drives the workspace materializer under lute against a fake DataModel the
// harness supplies. Requires `lute` on PATH (mise, in dev and CI).
const PROTOCOL_SOURCE = readLuauModule("protocol.luau");
const MODULE_SOURCE = readLuauModule("staging/materializer.luau").replace(
	'require("../protocol")',
	() => inlineModule(PROTOCOL_SOURCE),
);
const HARNESS = readHarness("materializer");

describe("workspace materializer under lute", () => {
	it("should pass the materializer harness assertions", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, {
			__MODULE__: MODULE_SOURCE,
			__PROTOCOL_MODULE__: PROTOCOL_SOURCE,
		});

		expect(spawnHarness("materializer-", script)).toContain("ALL OK");
	});
});
