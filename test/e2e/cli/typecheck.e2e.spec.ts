/**
 * E2e — single + projects(multi) `--typecheckOnly`.
 *
 * Drives the real CLI binary through config-load → discovery → classification →
 * grouping → real tsgo → result-merge → exit-code, in single and multi mode.
 * `--typecheckOnly` is pure-local tsgo: no rojo build, no Open Cloud, no secrets
 * — so this lives in the default `e2e` project (not the rojo/live-gated ones).
 *
 * The runner-level integration spec (`typecheck.integration.spec.ts`) calls
 * `runTypecheck` directly; the flow specs (`run/single.spec.ts`,
 * `run/multi.spec.ts`) mock it. Nothing else runs the binary end to end, so this
 * is the only guard on the CLI-arg → populated-`typecheckResult` wiring
 * (discovery globs, `-d` derivation, per-project grouping, exit code).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, readJsonSync, runCliAsync } from "./helpers.ts";

const SINGLE_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-single");
const SINGLE_BROKEN_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-single-broken");
const MULTI_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-multi");

interface MergedResult {
	testResults: Array<{ testFilePath: string }>;
}

describe("single --typecheckOnly e2e", () => {
	it("should run config-enabled type tests and exit 0 when they pass", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(SINGLE_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("1 passed");
	});

	it("should enable type tests from the --typecheckOnly flag and surface a failure", async () => {
		expect.assertions(3);

		// This fixture's config does NOT enable Type Tests — the CLI flag is the
		// entry point that turns them on (`only` implies `enabled`).
		const sandbox = createFixtureSandbox(SINGLE_BROKEN_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("should reject a string assigned to number");
		expect(output).toMatch(/TS\d+/);
	});
});

describe("multi --typecheckOnly e2e", () => {
	it("should group type tests per project and merge results across projects", async () => {
		expect.assertions(4);

		const sandbox = createFixtureSandbox(MULTI_FIXTURE);
		const outputFile = path.join(sandbox, "typecheck-result.json");

		const result = await runCliAsync(["--typecheckOnly", "--outputFile", outputFile], {
			cwd: sandbox,
		});

		// `beta` carries a deliberate type error checked against its own
		// tsconfig, so the run fails overall — but both projects' Type Tests
		// are reported.
		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("should reject a string assigned to number");

		const merged = readJsonSync(outputFile) as MergedResult;
		const paths = merged.testResults.map((file) => file.testFilePath);

		expect(paths.some((filePath) => filePath.includes("alpha"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("beta"))).toBeTrue();
	});

	it("should filter to one project with --project and exit 0 when it passes", async () => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(MULTI_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly", "--project", "alpha"], {
			cwd: sandbox,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("1 passed");
	});
});
