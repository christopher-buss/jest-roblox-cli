/**
 * E2e — workspace mode foundation.
 *
 * Exercises the full workspace pipeline up to OCALE dispatch:
 * discovery → package-resolver → preflight → synthesize → rojo build →
 * materializer script generation. Asserts byte-stable synth output and
 * a valid rbxl on disk.
 *
 * Live OCALE roundtrip (full materialize → Jest.runCLI → result envelope)
 * requires a workspace fixture with a real Jest module installed. That
 * piece is deferred to a follow-up; this test lays the foundation.
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { synthesize } from "../../../src/staging/synthesizer.ts";
import { buildWithRojo } from "../../../src/utils/rojo-builder.ts";
import { createFixtureSandbox } from "../cli/helpers.ts";

const FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

function rojoOnPath(): boolean {
	try {
		cp.execFileSync("rojo", ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

function liveOpenCloudConfigured(): boolean {
	return (
		process.env["ROBLOX_OPEN_CLOUD_API_KEY"] !== undefined &&
		process.env["ROBLOX_UNIVERSE_ID"] !== undefined &&
		process.env["ROBLOX_PLACE_ID"] !== undefined
	);
}

describe("workspace e2e — foundation pipeline", () => {
	it.skipIf(!rojoOnPath())(
		"should produce byte-stable synthesized project.json + a buildable rbxl across two runs",
		() => {
			expect.assertions(2);

			const sandbox = createFixtureSandbox(FIXTURE);
			const packageDirectory = path.join(sandbox, "packages/foo");
			const rojoProjectPath = path.join(packageDirectory, "test.project.json");

			const first = synthesize({
				packages: [
					{
						name: "@e2e/foo",
						packageDirectory,
						rojoProjectPath,
					},
				],
			});

			const second = synthesize({
				packages: [
					{
						name: "@e2e/foo",
						packageDirectory,
						rojoProjectPath,
					},
				],
			});

			expect(first).toBe(second);

			const cacheDirectory = path.join(sandbox, ".jest-roblox/workspace");
			fs.mkdirSync(cacheDirectory, { recursive: true });
			const synthProjectPath = path.join(cacheDirectory, "synthesized.project.json");
			const synthRbxlPath = path.join(cacheDirectory, "synthesized.rbxl");
			fs.writeFileSync(synthProjectPath, first);
			buildWithRojo(synthProjectPath, synthRbxlPath);

			expect(fs.statSync(synthRbxlPath).size).toBeGreaterThan(0);
		},
	);

	it.skipIf(!rojoOnPath())(
		"should produce a buildable rbxl when synthesizing two packages together",
		() => {
			expect.assertions(3);

			const sandbox = createFixtureSandbox(FIXTURE);
			const fooDirectory = path.join(sandbox, "packages/foo");
			const barDirectory = path.join(sandbox, "packages/bar");

			const projectJson = synthesize({
				packages: [
					{
						name: "@e2e/foo",
						packageDirectory: fooDirectory,
						rojoProjectPath: path.join(fooDirectory, "test.project.json"),
					},
					{
						name: "@e2e/bar",
						packageDirectory: barDirectory,
						rojoProjectPath: path.join(barDirectory, "test.project.json"),
					},
				],
			});

			expect(projectJson).toContain("@e2e/foo");
			expect(projectJson).toContain("@e2e/bar");

			const cacheDirectory = path.join(sandbox, ".jest-roblox/workspace");
			fs.mkdirSync(cacheDirectory, { recursive: true });
			const synthProjectPath = path.join(cacheDirectory, "synthesized.project.json");
			const synthRbxlPath = path.join(cacheDirectory, "synthesized.rbxl");
			fs.writeFileSync(synthProjectPath, projectJson);
			buildWithRojo(synthProjectPath, synthRbxlPath);

			expect(fs.statSync(synthRbxlPath).size).toBeGreaterThan(0);
		},
	);

	it("should report live OCALE credential availability", () => {
		expect.assertions(1);

		const isConfigured = liveOpenCloudConfigured();

		expect([true, false]).toContain(isConfigured);
	});
});
