import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the shared infinite-yield watchdog under lute. Its only dependency is
// LogService, which the harness fakes. Requires `lute` on PATH (mise, in dev
// and CI).
const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(CURRENT_DIRECTORY, "../../luau");
const MODULE_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "infinite-yield.luau"), "utf-8");
const HARNESS = fs.readFileSync(
	path.join(CURRENT_DIRECTORY, "infinite-yield.harness.luau"),
	"utf-8",
);

describe("infinite-yield watchdog under lute", () => {
	it("should pass the infinite-yield harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "infinite-yield-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
