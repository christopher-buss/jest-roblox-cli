import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { synthesize } from "../src/staging/synthesizer.ts";
import { buildWithRojo } from "../src/utils/rojo-builder.ts";

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function createTemporaryDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synth-rojo-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

describe("synthesizer + rojo build integration", () => {
	it.skipIf(!rojoOnPath())(
		"should produce a project.json that rojo can build into a valid rbxl",
		() => {
			expect.assertions(2);

			const workspace = createTemporaryDirectory();
			const packageDirectory = path.join(workspace, "packages/foo");
			fs.mkdirSync(path.join(packageDirectory, "src"), { recursive: true });
			fs.writeFileSync(path.join(packageDirectory, "src", "example.luau"), "return {}\n");
			fs.writeFileSync(
				path.join(packageDirectory, "test.project.json"),
				JSON.stringify({
					name: "foo-test",
					tree: {
						$className: "DataModel",
						ReplicatedStorage: { $className: "ReplicatedStorage", $path: "src" },
					},
				}),
			);

			const synthesized = synthesize({
				packages: [
					{
						name: "@halcyon/foo",
						packageDirectory,
						rojoProjectPath: path.join(packageDirectory, "test.project.json"),
					},
				],
			});

			const synthDirectory = path.join(workspace, ".jest-roblox/workspace");
			fs.mkdirSync(synthDirectory, { recursive: true });
			const synthProjectPath = path.join(synthDirectory, "synthesized.project.json");
			const synthRbxlPath = path.join(synthDirectory, "synthesized.rbxl");
			fs.writeFileSync(synthProjectPath, synthesized);

			buildWithRojo(synthProjectPath, synthRbxlPath);

			expect(fs.existsSync(synthRbxlPath)).toBeTrue();
			expect(fs.statSync(synthRbxlPath).size).toBeGreaterThan(0);
		},
	);
});
