import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

import { LUTE_HARNESS_TIMEOUT } from "./lute-timeout.ts";

// Drives the last-seen record under lute. Its circus-hook and data-model-path
// dependencies are inlined in place of the relative requires, then the whole
// module is inlined into the harness the same way the runner welds it. Requires
// `lute` on PATH (mise, in dev and CI).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(HERE, "../../luau");
const HOOK_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "circus-hook.luau"), "utf-8");
const PATH_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "data-model-path.luau"), "utf-8");
const MODULE_SOURCE = fs
	.readFileSync(path.join(LUAU_DIRECTORY, "last-seen.luau"), "utf-8")
	.replace('require("./circus-hook")', () => `(function()\n${HOOK_SOURCE}\nend)()`)
	.replace('require("./data-model-path")', () => `(function()\n${PATH_SOURCE}\nend)()`);
const HARNESS = fs.readFileSync(path.join(HERE, "last-seen.harness.luau"), "utf-8");

describe("last-seen record under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the last-seen harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "last-seen-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
