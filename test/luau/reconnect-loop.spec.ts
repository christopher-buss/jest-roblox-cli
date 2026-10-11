import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

import { LUTE_HARNESS_TIMEOUT } from "./lute-timeout.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = fs.readFileSync(
	path.join(HERE, "../../plugin/src/reconnect-loop.luau"),
	"utf-8",
);
const HARNESS = fs.readFileSync(path.join(HERE, "reconnect-loop.harness.luau"), "utf-8");

describe("edit-mode plugin reconnect loop under lute", { timeout: LUTE_HARNESS_TIMEOUT }, () => {
	it("should pass the reconnect-loop harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reconnect-loop-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});
		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		expect(spawnLute({ args: [], scriptPath })).toContain("ALL OK");
	});
});
