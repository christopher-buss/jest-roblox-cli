import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the per-test progress heartbeat under lute: what it publishes, when
// the throttle lets a write through, and that it joins every test file's own
// circus registry. Its circus-hook dependency is inlined in place of the
// relative require, the way the runner welds it. Requires `lute` on PATH
// (mise, in dev and CI).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(HERE, "../../luau");
const HOOK_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "circus-hook.luau"), "utf-8");
const PATH_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "data-model-path.luau"), "utf-8");
const MODULE_SOURCE = fs
	.readFileSync(path.join(LUAU_DIRECTORY, "test-progress.luau"), "utf-8")
	.replace('require("./circus-hook")', () => `(function()\n${HOOK_SOURCE}\nend)()`)
	.replace('require("./data-model-path")', () => `(function()\n${PATH_SOURCE}\nend)()`);
const HARNESS = fs.readFileSync(path.join(HERE, "test-progress.harness.luau"), "utf-8");

describe("per-test progress heartbeat under lute", () => {
	it("should pass the progress harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "test-progress-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
