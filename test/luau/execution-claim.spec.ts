import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import claimSource from "../../luau/execution-claim.luau";
import { EXECUTION_NOT_CLAIMED, EXECUTION_START_EXPIRED } from "../../src/luau/execution-claim.ts";
import { prepareTaskScript } from "../../src/luau/task-script.ts";
import { LUTE_HARNESS_TIMEOUT } from "./lute-timeout.ts";

describe("execution claim", () => {
	it(
		"should admit one execution through contention, expiry and uncertain MemoryStore writes",
		{
			timeout: LUTE_HARNESS_TIMEOUT,
		},
		() => {
			expect.assertions(1);

			const harness = fs.readFileSync(
				path.join(import.meta.dirname, "execution-claim.harness.luau"),
				"utf8",
			);
			const source = claimSource.replace("__EXECUTION_CLAIM_PARAMETERS__", () => {
				return `key, 2000, 300, ${JSON.stringify(EXECUTION_NOT_CLAIMED)}, ${JSON.stringify(EXECUTION_START_EXPIRED)}`;
			});
			const guarded = prepareTaskScript({
				hasRebuild: true,
				placeVersion: 42,
				script: '--!strict\nerror("Tests must not run")',
			})(`${source}\n`);
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-claim-"));
			onTestFinished(() => {
				fs.rmSync(directory, { force: true, recursive: true });
			});
			const scriptPath = path.join(directory, "harness.luau");
			fs.writeFileSync(
				scriptPath,
				harness
					.replace("__NOT_CLAIMED__", () => JSON.stringify(EXECUTION_NOT_CLAIMED))
					.replace("__START_EXPIRED__", () => JSON.stringify(EXECUTION_START_EXPIRED))
					.replace("__CLAIM__", () => source)
					.replace("__GUARDED__", () => guarded),
			);

			expect(spawnLute({ args: [], scriptPath })).toContain("ALL OK");
		},
	);
});
