import { ExecutionTimeoutError, OcaleRunner } from "@isentinel/roblox-runner";
import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";
import { assert, describe, expect, it, vi } from "vitest";

import { executeWithRecoveryAsync } from "../../../src/backends/execution-recovery.ts";
import { IS_LIVE } from "./live-gate.ts";

describe("original execution result", () => {
	it.skipIf(!IS_LIVE)(
		"should recover a completed original after its observer times out on Roblox",
		{ retry: 0, timeout: 120_000 },
		async () => {
			expect.assertions(2);

			const runner = new OcaleRunner({
				apiKey: process.env["ROBLOX_OPEN_CLOUD_API_KEY"]!,
				placeId: process.env["ROBLOX_PLACE_ID"]!,
				universeId: process.env["ROBLOX_UNIVERSE_ID"]!,
			});
			const executeAsync = vi
				.fn<(claim: string) => Promise<ScriptResult>>()
				.mockImplementationOnce(async (claim) => {
					const failure: unknown = await runner
						.executeScriptAsync({
							pollBudget: 0,
							script: `${claim}\nreturn "ORIGINAL"`,
							timeout: 30_000,
						})
						.catch((err: unknown) => err);
					assert(failure instanceof ExecutionTimeoutError);
					// Establish that the original owns the claim before allowing
					// the replacement to race it.
					await vi.waitFor(
						async () => {
							const original = await failure.readResultAsync();
							assert(original!.outputs[0] === "ORIGINAL");
						},
						{ interval: 500, timeout: 60_000 },
					);
					throw failure;
				})
				.mockImplementation(async (claim) => {
					return runner.executeScriptAsync({
						script: `${claim}\nreturn "DUPLICATE"`,
						timeout: 30_000,
					});
				});

			const recovered = await executeWithRecoveryAsync({ executeAsync, timeout: 30_000 });

			expect(recovered.outputs).toStrictEqual(["ORIGINAL"]);
			expect(executeAsync).toHaveBeenCalledTimes(2);
		},
	);
});
