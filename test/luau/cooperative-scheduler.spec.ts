import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

import { LUTE_HARNESS_TIMEOUT } from "./lute-timeout.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(HERE, "../../luau");
const HOOK_SOURCE = fs.readFileSync(path.join(LUAU_DIRECTORY, "circus-hook.luau"), "utf-8");
const MODULE_SOURCE = fs.readFileSync(
	path.join(LUAU_DIRECTORY, "cooperative-scheduler.luau"),
	"utf-8",
);
const HARNESS = fs.readFileSync(path.join(HERE, "cooperative-scheduler.harness.luau"), "utf-8");

describe("cooperative scheduling under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should yield between completed tests while preserving hooks and run ownership", () => {
		expect.assertions(1);

		const source = HARNESS.replace(
			"__HOOK__",
			() => `(function()\n${HOOK_SOURCE}\nend)()`,
		).replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cooperative-scheduler-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});
		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, source, "utf-8");

		expect(spawnLute({ args: [], scriptPath })).toContain("ALL OK");
	});
});
