import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where every fixture sandbox in this package is rooted, whichever project
 * builds it: the `e2e`, `live` and `integration` specs all reach
 * `createFixtureSandbox`. Inside the repo rather than `os.tmpdir()` on
 * purpose: a sandbox a failing test left behind stays readable beside the
 * fixture it was copied from.
 */
const SANDBOX_ROOT = path.resolve(import.meta.dirname, "cli", ".tmp");

/**
 * The `mkdtemp` prefix every sandbox carries, and the only name the sweep
 * deletes.
 */
const SANDBOX_PREFIX = "jest-roblox-cli-e2e-";

/**
 * How old a sandbox must be before the sweep will delete it. The longest a
 * live sandbox stays on disk is one test: 120s of `testTimeout` times three
 * attempts under `retry: 2`, so an hour leaves ten times that 360s budget as
 * margin.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

export function createSandboxDirectory(): string {
	mkdirSync(SANDBOX_ROOT, { recursive: true });
	return mkdtempSync(path.join(SANDBOX_ROOT, SANDBOX_PREFIX));
}

/**
 * Deletes the sandboxes an earlier run left in `root`. Sandbox teardown is an
 * `onTestFinished` hook, so a run that is interrupted — Ctrl-C, a harness
 * kill, a crash — leaks its whole tree, and a `--coverage` sandbox is an
 * instrumented shadow of the fixture rather than a handful of files.
 *
 * Reclaiming disk is all this does; the `exclude` in `vitest.config.ts` is
 * what keeps a leaked sandbox from being collected as a spec. So the sweep can
 * afford to be timid, and has to be: the root is shared with the `live` and
 * `integration` projects, and CI runs `e2e` and `e2e-live` concurrently. Only
 * entries past `STALE_AFTER_MS` go, which no run still holding one can be —
 * the price being that a sandbox leaked minutes ago survives until an hour
 * has passed.
 */
export function sweepStaleSandboxes(root = SANDBOX_ROOT): void {
	if (!existsSync(root)) {
		return;
	}

	const staleBefore = Date.now() - STALE_AFTER_MS;
	for (const entry of readdirSync(root)) {
		if (!entry.startsWith(SANDBOX_PREFIX)) {
			continue;
		}

		// `throwIfNoEntry` because the same concurrent run can take its
		// sandbox away between the listing and this line, and an ENOENT
		// raised here would fail the whole run from `globalSetup`.
		const entryPath = path.join(root, entry);
		const stats = statSync(entryPath, { throwIfNoEntry: false });
		if (stats !== undefined && stats.mtimeMs < staleBefore) {
			rmSync(entryPath, { force: true, recursive: true });
		}
	}
}
