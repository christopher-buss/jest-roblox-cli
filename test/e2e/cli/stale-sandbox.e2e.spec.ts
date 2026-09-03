import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { normalizeWindowsPath } from "../../../src/utils/normalize-windows-path.ts";
import { createSandboxDirectory, sweepStaleSandboxes } from "../sandbox-root.ts";

const PACKAGE_ROOT = path.resolve(__dirname, "../../..");
const VITEST_BIN = path.resolve(PACKAGE_ROOT, "node_modules/vitest/vitest.mjs");

/**
 * Every project whose include glob reaches the sandbox root, paired with a
 * file it is known to collect. The sentinel is spelled the way the file list
 * prints one, and proves two things at once: the exclude did not swallow the
 * real suite, and the list really does print forward slashes. Without that
 * second half the negative assertions below could be needles that never match
 * anything.
 *
 * `e2e`'s sentinel is this very file, collected by definition because it is
 * running. `integration` globs `*.integration.spec.ts`, which no file under
 * `test/e2e/` matches, so it names one of its own.
 */
const COLLECTING_PROJECTS = [
	{ name: "e2e", sentinel: "test/e2e/cli/stale-sandbox.e2e.spec.ts" },
	{ name: "integration", sentinel: "test/integration/typecheck.integration.spec.ts" },
] as const;

/**
 * One decoy per include glob that reaches the sandbox root: `e2e` globs
 * `test/e2e/**\/*.spec.ts` and `integration` globs `*.integration.spec.ts`.
 * Both land in the same sandbox, because that is how an interrupted run leaks
 * them — whichever project built the sandbox, the fixture tree it copied is
 * left there whole.
 */
const DECOY_SPEC_NAMES = {
	e2e: "example.spec.ts",
	integration: "example.integration.spec.ts",
} satisfies Record<string, string>;

const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);

/**
 * What an interrupted run leaves behind: a sandbox whose copied fixture
 * carries Roblox specs, which fail on the Luau `print` global the moment a
 * later run collects one.
 *
 * Built through the entry point the fixture helpers use, so the decoys land
 * wherever real sandboxes land rather than wherever this file guesses.
 *
 * Returns the paths as the file list prints them.
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
		return normalizeWindowsPath(path.relative(PACKAGE_ROOT, specPath));
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
 */
function listProjectFiles(project: string): string {
	return execFileSync("node", [VITEST_BIN, "list", "--filesOnly", "--project", project], {
		cwd: PACKAGE_ROOT,
		encoding: "utf-8",
		windowsHide: true,
	});
}

/**
 * A stand-in sandbox root outside the repo. The real one holds the live
 * sandboxes of every other file running in parallel, and sweeping it here
 * would delete them mid-test.
 */
function makeSweepRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "jest-roblox-sweep-"));
	onTestFinished(() => {
		rmSync(root, { force: true, recursive: true });
	});
	return root;
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

describe(sweepStaleSandboxes, () => {
	it("should delete a sandbox an interrupted run left behind", () => {
		expect.assertions(1);

		const root = makeSweepRoot();
		const leaked = path.join(root, "jest-roblox-cli-e2e-Ab3xYz");
		mkdirSync(path.join(leaked, "rbxts-project", "src"), { recursive: true });
		utimesSync(leaked, ONE_DAY_AGO, ONE_DAY_AGO);

		sweepStaleSandboxes(root);

		expect(existsSync(leaked)).toBeFalse();
	});

	// The root sits in the repo so a sandbox can be read after the test that
	// built it failed. Renaming one out of the `mkdtemp` prefix is how you keep
	// it past the next run, so the sweep matches on that prefix rather than
	// emptying the directory.
	it("should leave a renamed sandbox kept for inspection alone", () => {
		expect.assertions(1);

		const root = makeSweepRoot();
		const kept = path.join(root, "keep-the-failing-one");
		mkdirSync(kept, { recursive: true });
		utimesSync(kept, ONE_DAY_AGO, ONE_DAY_AGO);

		sweepStaleSandboxes(root);

		expect(existsSync(kept)).toBeTrue();
	});

	// The root is shared: the `live` and `integration` projects build sandboxes
	// in it too, and CI runs `nx affected --parallel=2 -t e2e e2e-live`. A sweep
	// that deleted whatever it found would take a concurrent run's live sandbox
	// with it, mid-test.
	it("should leave a sandbox young enough to belong to a running suite", () => {
		expect.assertions(1);

		const root = makeSweepRoot();
		const inFlight = path.join(root, "jest-roblox-cli-e2e-Cd4wXy");
		mkdirSync(inFlight, { recursive: true });

		sweepStaleSandboxes(root);

		expect(existsSync(inFlight)).toBeTrue();
	});

	// The same concurrency, one step finer: a live run's `onTestFinished` can
	// take its sandbox away between the listing and the measurement. A dangling
	// link is that gap made reproducible — the name is listed, and reading it
	// raises ENOENT. Throwing here would fail the whole run from `globalSetup`,
	// which is the outcome the age gate exists to avoid.
	it("should skip an entry that disappears before it is measured", () => {
		expect.assertions(1);

		const root = makeSweepRoot();
		symlinkSync(
			path.join(root, "already-deleted"),
			path.join(root, "jest-roblox-cli-e2e-Ef5zAb"),
			"junction",
		);

		expect(() => {
			sweepStaleSandboxes(root);
		}).not.toThrow();
	});
});
