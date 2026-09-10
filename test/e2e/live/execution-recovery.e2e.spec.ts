import { PollTimeoutError } from "@bedrock-rbx/ocale";
import { LuauExecutionClient } from "@bedrock-rbx/ocale/luau-execution";
import type { LuauExecutionTaskRef } from "@bedrock-rbx/ocale/luau-execution";
import { OcaleRunner } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import { randomUUID } from "node:crypto";
import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import { executeWithRecoveryAsync } from "../../../src/backends/execution-recovery.ts";
import { EXECUTION_NOT_CLAIMED } from "../../../src/luau/execution-claim.ts";
import { IS_LIVE } from "./live-gate.ts";

describe("execution claim", () => {
	it.skipIf(!IS_LIVE)(
		"should recover a pending task and refuse its delayed original on Roblox",
		{
			retry: 0,
			timeout: 120_000,
		},
		async () => {
			expect.assertions(3);

			const credentials = {
				apiKey: process.env["ROBLOX_OPEN_CLOUD_API_KEY"]!,
				placeId: process.env["ROBLOX_PLACE_ID"]!,
				universeId: process.env["ROBLOX_UNIVERSE_ID"]!,
			};
			const client = new LuauExecutionClient({ apiKey: credentials.apiKey });
			const runner = new OcaleRunner(credentials);
			const gate =
				'game:GetService("MemoryStoreService"):GetHashMap("jest-roblox-recovery-test")';
			const releaseKey = JSON.stringify(randomUUID());
			let original: LuauExecutionTaskRef | undefined;
			const executeAsync = vi
				.fn<(claim: string) => Promise<ScriptResult>>()
				.mockImplementationOnce(async (claim) => {
					const submitted = await client.tasks.submit({
						placeId: credentials.placeId,
						script: `local gate = ${gate}
local deadline = os.clock() + 60
while gate:GetAsync(${releaseKey}) == nil do
	assert(os.clock() < deadline, "Replacement did not release the original")
	task.wait(0.2)
end
${claim}
return "DUPLICATE"`,
						timeoutSeconds: 90,
						universeId: credentials.universeId,
					});
					assert(
						submitted.success,
						"Original task must be accepted before simulating its lost poll",
					);
					original = submitted.data.ref;
					// The real task remains pending; only this observer's poll
					// budget expires.
					throw new PollTimeoutError("Simulated lost poll", { timeoutMs: 1 });
				})
				.mockImplementation(async (claim) => {
					return runner.executeScriptAsync({
						script: `${claim}\n${gate}:SetAsync(${releaseKey}, true, 120)\nreturn "EXECUTED"`,
						timeout: 30_000,
					});
				});
			const recovered = await executeWithRecoveryAsync({ executeAsync, timeout: 30_000 });
			assert(original !== undefined);
			const delayed = await client.tasks.pollUntilDone(original, { timeoutMs: 90_000 });
			assert(delayed.success);
			assert(delayed.data.state === "COMPLETE");

			expect(recovered.outputs).toStrictEqual(["EXECUTED"]);
			expect(delayed.data.output.results).toStrictEqual([EXECUTION_NOT_CLAIMED]);
			expect(executeAsync).toHaveBeenCalledTimes(2);
		},
	);
});
