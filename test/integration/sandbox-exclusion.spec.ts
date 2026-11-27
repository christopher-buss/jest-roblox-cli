import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "vitest";

import { createSandboxDirectory } from "#test/helpers/integration/sandbox-root.ts";

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const VITEST_BIN = path.resolve(PACKAGE_ROOT, "node_modules/vitest/vitest.mjs");

const COLLECTING_PROJECTS = [{ name: "e2e", sentinel: "test/e2e/bundle.spec.ts" }] as const;

const DECOY_SPEC_NAMES = {
	e2e: "example.spec.ts",
	integration: "example.integration.spec.ts",
} satisfies Record<string, string>;

function plantStaleSandbox(
	onTestFinished: TestContext["onTestFinished"],
): Record<keyof typeof DECOY_SPEC_NAMES, string> {
	const directory = createSandboxDirectory();
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});

	const specDirectory = path.join(directory, "rbxts-project", "src");
	mkdirSync(specDirectory, { recursive: true });

	function plant(name: string): string {
		const specPath = path.join(specDirectory, name);
		writeFileSync(specPath, 'print("stale sandbox");\n');
		return path.relative(PACKAGE_ROOT, specPath).replaceAll("\\", "/");
	}

	return {
		e2e: plant(DECOY_SPEC_NAMES.e2e),
		integration: plant(DECOY_SPEC_NAMES.integration),
	};
}

function listProjectFiles(project: string): string {
	return execFileSync(
		"node",
		[VITEST_BIN, "list", "--filesOnly", "--no-fsModuleCache", "--project", project],
		{
			cwd: PACKAGE_ROOT,
			encoding: "utf-8",
			timeout: 10_000,
			windowsHide: true,
		},
	);
}

describe("file collection", () => {
	it.for(COLLECTING_PROJECTS)(
		"should keep a sandbox left behind in .tmp out of $name's file list",
		({ name, sentinel }, { expect, onTestFinished }) => {
			expect.assertions(3);

			const stale = plantStaleSandbox(onTestFinished);

			const listed = listProjectFiles(name);

			expect(listed).toContain(sentinel);
			expect(listed).not.toContain(stale.e2e);
			expect(listed).not.toContain(stale.integration);
		},
	);
});
