import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Drives the shared `_timing` envelope builder under lute. Pure module, no
// dependencies to inline. Requires `lute` on PATH (mise, in dev and CI).
const here = path.dirname(fileURLToPath(import.meta.url));
const luauDirectory = path.join(here, "../../luau");
const moduleSource = fs.readFileSync(path.join(luauDirectory, "phase-timing.luau"), "utf-8");
const harness = fs.readFileSync(path.join(here, "phase-timing.harness.luau"), "utf-8");

describe("shared phase-timing builder under lute", () => {
	it("should pass the phase-timing harness assertions", () => {
		expect.assertions(1);

		const script = harness.replace("__MODULE__", () => `(function()\n${moduleSource}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phase-timing-"));
		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		try {
			const stdout = spawnLute({ args: [], scriptPath });

			expect(stdout).toContain("ALL OK");
		} finally {
			fs.rmSync(directory, { force: true, recursive: true });
		}
	});
});
