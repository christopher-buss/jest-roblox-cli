import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createSandboxDirectory } from "#test/e2e/sandbox-root.ts";

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const VITEST_BIN = path.resolve(PACKAGE_ROOT, "node_modules/vitest/vitest.mjs");

/**
 * The project whose include glob reaches the sandbox root, paired with a file
 * it is known to collect. The sentinel is spelled the way the file list prints
 * one, and proves two things at once: the exclude did not swallow the real
 * suite, and the list really does print forward slashes. Without that second
 * half the negative assertions below could be needles that never match
 * anything. The sentinel is a spec that project always holds.
 */
const COLLECTING_PROJECTS = [{ name: "e2e", sentinel: "test/e2e/bundle.spec.ts" }] as const;

/**
 * Two spec spellings the `e2e` glob collects, planted in one sandbox, because
 * that is how an interrupted run leaks them: the fixture tree it copied is left
 * there whole.
 */
const DECOY_SPEC_NAMES = {
	e2e: "example.spec.ts",
	integration: "example.integration.spec.ts",
} satisfies Record<string, string>;

/**
 * What an interrupted run leaves behind: a sandbox whose copied fixture
 * carries Roblox specs, which fail on the Luau `print` global the moment a
 * later run collects one.
 *
 * Built through the entry point the fixture helpers use, so the decoys land
 * wherever real sandboxes land rather than wherever this file guesses.
 *
 * Returns the paths as the file list prints them.
 * @returns Decoy spec path per project.
 */
function plantStaleSandbox(): Record<keyof typeof DECOY_SPEC_NAMES, string> {
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

/**
 * The real collector rather than a glob library standing in for it:
 * `--filesOnly` globs the project and prints what it found without running or
 * typechecking anything.
 *
 * `--no-fsModuleCache`: on a lockfile change Vitest deletes the workspace-wide
 * module cache that concurrent runs are writing into, failing with ENOTEMPTY.
 * @param project - Vitest project name.
 * @returns The file list Vitest prints.
 */
function listProjectFiles(project: string): string {
	return execFileSync(
		"node",
		[VITEST_BIN, "list", "--filesOnly", "--no-fsModuleCache", "--project", project],
		{
			cwd: PACKAGE_ROOT,
			encoding: "utf-8",
			windowsHide: true,
		},
	);
}

describe("file collection", () => {
	it.for(COLLECTING_PROJECTS)(
		"should keep a sandbox left behind in .tmp out of $name's file list",
		({ name, sentinel }) => {
			expect.assertions(3);

			const stale = plantStaleSandbox();

			const listed = listProjectFiles(name);

			expect(listed).toContain(sentinel);
			expect(listed).not.toContain(stale.e2e);
			expect(listed).not.toContain(stale.integration);
		},
	);
});
