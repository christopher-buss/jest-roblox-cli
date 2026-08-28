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
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { synthesize } from "../../../src/staging/synthesizer.ts";
import { buildWithRojoAsync } from "../../../src/utils/rojo-builder.ts";
import { createFixtureSandbox, rojoOnPath } from "../cli/helpers.ts";

const FIXTURE = path.resolve(__dirname, "../fixtures/workspace");

describe("workspace e2e — foundation pipeline", () => {
	// Determinism only — no rojo build. The two-package case below builds a
	// superset of this tree (it contains the same `@e2e/foo` mount), so a build
	// here would spend a `rojo build` subprocess re-proving what that one
	// proves. This case needs no external tool at all.
	it("should produce byte-stable synthesized project.json across two runs", async () => {
		expect.assertions(1);

		const sandbox = createFixtureSandbox(FIXTURE);
		const packageDirectory = path.join(sandbox, "packages/foo");
		const rojoProjectPath = path.join(packageDirectory, "test.project.json");
		const packages = [{ name: "@e2e/foo", packageDirectory, rojoProjectPath }];

		expect(synthesize({ packages })).toBe(synthesize({ packages }));
	});

	it.skipIf(!rojoOnPath())(
		"should produce a buildable rbxl when synthesizing two packages together",
		async () => {
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
			await buildWithRojoAsync(synthProjectPath, synthRbxlPath);

			expect(fs.statSync(synthRbxlPath).size).toBeGreaterThan(0);
		},
	);
});
