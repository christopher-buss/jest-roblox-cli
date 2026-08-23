import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

// Drives the embedded workspace runner under lute with the real Game Output
// capture module and every other sibling stubbed by the harness. Requires
// `lute` on PATH (mise, in dev and CI).
const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const LUAU_DIRECTORY = path.join(CURRENT_DIRECTORY, "../../luau");
const MODULE_SOURCE = fs.readFileSync(
	path.join(LUAU_DIRECTORY, "staging/embedded-runner.luau"),
	"utf-8",
);
const CAPTURE_SOURCE = fs.readFileSync(
	path.join(LUAU_DIRECTORY, "game-output-capture.luau"),
	"utf-8",
);
const HARNESS = fs.readFileSync(
	path.join(CURRENT_DIRECTORY, "embedded-runner.harness.luau"),
	"utf-8",
);

describe("embedded workspace runner under lute", () => {
	it("should pass the embedded-runner harness assertions", () => {
		expect.assertions(1);

		const script = HARNESS.replace(
			"__CAPTURE_MODULE__",
			() => `(function()\n${CAPTURE_SOURCE}\nend)()`,
		).replace("__MODULE__", () => `(function()\n${MODULE_SOURCE}\nend)()`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-runner-"));
		onTestFinished(() => {
			fs.rmSync(directory, { force: true, recursive: true });
		});

		const scriptPath = path.join(directory, "harness.luau");
		fs.writeFileSync(scriptPath, script, "utf-8");

		const stdout = spawnLute({ args: [], scriptPath });

		expect(stdout).toContain("ALL OK");
	});
});
