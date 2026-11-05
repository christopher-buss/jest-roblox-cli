import { describe, expect, it } from "vitest";

import { readHarness, readLuauModule, spawnHarness } from "#test/luau/lute-harness.ts";
import { LUTE_HARNESS_TIMEOUT } from "#test/luau/lute-timeout.ts";

const EXECUTION_NOT_CLAIMED = "__JEST_ROBLOX_EXECUTION_NOT_CLAIMED__";
const EXECUTION_START_EXPIRED = "__JEST_ROBLOX_EXECUTION_START_EXPIRED__";
const CLAIM_SOURCE = readLuauModule("execution-claim.luau");
const CODE_BUNDLE_REBUILD_SOURCE = readLuauModule("code-bundle-rebuild.luau");
const HARNESS = readHarness("execution-claim");

describe("execution claim", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should admit one execution through contention, expiry and uncertain MemoryStore writes", () => {
		expect.assertions(1);

		const source = CLAIM_SOURCE.replace("__EXECUTION_CLAIM_PARAMETERS__", () => {
			return `key, 2000, 300, ${JSON.stringify(EXECUTION_NOT_CLAIMED)}, ${JSON.stringify(EXECUTION_START_EXPIRED)}`;
		});
		const claimed = `--!strict\n${source}\n${CODE_BUNDLE_REBUILD_SOURCE}\nerror("Tests must not run")`;
		const script = HARNESS.replace("__NOT_CLAIMED__", () => {
			return JSON.stringify(EXECUTION_NOT_CLAIMED);
		})
			.replace("__START_EXPIRED__", () => JSON.stringify(EXECUTION_START_EXPIRED))
			.replace("__CLAIM__", () => source)
			.replace("__CLAIMED__", () => claimed);

		expect(spawnHarness("execution-claim-", script)).toContain("ALL OK");
	});
});
