import { describe, expect, it } from "vitest";

import {
	fillPlaceholders,
	readHarness,
	readLuauTree,
	spawnHarness,
	stubbedModules,
} from "#test/luau/lute-harness.ts";

const HARNESS = readHarness("envelope");
const STUBBED = stubbedModules(HARNESS);

describe("task envelope builder under lute", () => {
	it("should build the wire shapes the CLI reads", () => {
		expect.assertions(1);

		const script = fillPlaceholders(HARNESS, {
			__MODULE__: readLuauTree("envelope.luau", STUBBED),
		});

		expect(spawnHarness("envelope-", script)).toContain("ALL OK");
	});
});
