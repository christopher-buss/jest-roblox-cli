import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the attribution module under the real lute binary, inlining it into the
// harness the same way the runner welds it. The harness exercises the pure
// snapshot/diff logic against a hand-built coverage hit table and calls error()
// on any failed assertion, so a non-zero lute exit fails this test. Requires
// `lute` on PATH (mise, in dev and CI). The source is read from disk (rather than
// imported) so the spec needs no `*.luau` ambient declaration.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = fs.readFileSync(
	path.join(HERE, "../../luau/coverage-attribution.luau"),
	"utf-8",
);
const HARNESS = fs.readFileSync(path.join(HERE, "coverage-attribution.harness.luau"), "utf-8");

describe("coverage attribution under lute", () => {
	it("should pass the attribution harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cov-attr-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
