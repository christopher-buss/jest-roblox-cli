import { describe, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauModule,
	spawnHarness,
} from "#test/helpers/integration/lute-harness.ts";

describe("edit-mode plugin socket url under lute", () => {
	it("should dial the port the place names, or the default", ({ expect }) => {
		expect.assertions(1);

		const script = fillPlaceholders(readHarness("socket-url"), {
			__MODULE__: readLuauModule("../plugin/src/socket-url.luau"),
			__PROTOCOL_MODULE__: readLuauModule("protocol.luau"),
		});

		expect(spawnHarness("socket-url-", script)).toContain("ALL OK");
	});
});
