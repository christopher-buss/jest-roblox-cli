import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the shared runner-result builder under lute. Its instance-resolver and
// per-test-coverage dependencies are stubbed by the harness, which the module
// picks up by being inlined into it. Requires `lute` on PATH (mise, in dev and
// CI).
const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(CURRENT_DIRECTORY, "../../luau");
const MODULE_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "runner-result.luau"), "utf-8");
const HARNESS = fs.readFileSync(
	path.join(CURRENT_DIRECTORY, "runner-result.harness.luau"),
	"utf-8",
);

describe("shared runner-result builder under lute", () => {
	it("should pass the runner-result harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runner-result-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
