import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the per-test coverage hook under lute. Its coverage-attribution
// dependency is inlined in place of the relative require, then the whole module
// is inlined into the harness the same way the runner welds it. Requires `lute`
// on PATH (mise, in dev and CI).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(HERE, "../../luau");
const ATTRIBUTION_SOURCE = fs.readFileSync(
	path.join(LUAU_DIRECTORY, "coverage-attribution.luau"),
	"utf-8",
);
const MODULE_SOURCE = fs
	.readFileSync(path.join(LUAU_DIRECTORY, "per-test-coverage.luau"), "utf-8")
	.replace(
		'require("./coverage-attribution")',
		() => `(function()\n${ATTRIBUTION_SOURCE}\nend)()`,
	);
const HARNESS = fs.readFileSync(path.join(HERE, "per-test-coverage.harness.luau"), "utf-8");

describe("per-test coverage hook under lute", () => {
	it("should pass the per-test coverage harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "per-test-cov-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
