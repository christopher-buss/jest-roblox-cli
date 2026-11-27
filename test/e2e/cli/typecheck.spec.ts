import * as path from "node:path";
import { describe, it } from "vitest";

import {
	createFixtureSandbox,
	readMergedTestFilePaths,
	runCliAsync,
} from "#test/helpers/integration/helpers.ts";

const SINGLE_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-single");
const SINGLE_BROKEN_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-single-broken");
const MULTI_FIXTURE = path.resolve(__dirname, "../fixtures/typecheck-multi");

describe("single --typecheckOnly e2e", () => {
	it("should run config-enabled type tests and exit 0 when they pass", async ({ expect }) => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(SINGLE_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly"], { cwd: sandbox });

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("1 passed");
	});

	it("should enable type tests from the --typecheckOnly flag and surface a failure", async ({
		expect,
	}) => {
		expect.assertions(3);

		// This fixture's config does NOT enable Type Tests. The CLI flag is the
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
	it("should group type tests per project and merge results across projects", async ({
		expect,
	}) => {
		expect.assertions(4);

		const sandbox = createFixtureSandbox(MULTI_FIXTURE);
		const outputFile = path.join(sandbox, "typecheck-result.json");

		const result = await runCliAsync(["--typecheckOnly", "--outputFile", outputFile], {
			cwd: sandbox,
		});

		// `beta` carries a deliberate type error checked against its own
		// tsconfig, so the run fails overall, but both projects' Type Tests
		// are reported.
		const output = result.stdout + result.stderr;

		expect(result.exitCode).toBe(1);
		expect(output).toContain("should reject a string assigned to number");

		const paths = readMergedTestFilePaths(outputFile);

		expect(paths.some((filePath) => filePath.includes("alpha"))).toBeTrue();
		expect(paths.some((filePath) => filePath.includes("beta"))).toBeTrue();
	});

	it("should filter to one project with --project and exit 0 when it passes", async ({
		expect,
	}) => {
		expect.assertions(2);

		const sandbox = createFixtureSandbox(MULTI_FIXTURE);

		const result = await runCliAsync(["--typecheckOnly", "--project", "alpha"], {
			cwd: sandbox,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout + result.stderr).toContain("1 passed");
	});
});
