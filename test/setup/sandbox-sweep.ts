import path from "node:path";

import type { FileSystem } from "../../src/utils/file-system.ts";

export const SANDBOX_PREFIX = "jest-roblox-cli-e2e-";

/**
 * How old a sandbox must be before the sweep will delete it. The longest a
 * live sandbox stays on disk is one test: 120s of `testTimeout` times three
 * attempts under `retry: 2`, so an hour leaves ten times that 360s budget as
 * margin.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface SandboxSweep {
	readonly fileSystem: Pick<FileSystem, "existsSync" | "readdirSync" | "rmSync" | "statSync">;
	readonly now: number;
	readonly root: string;
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
 * @param sweep - Root to sweep, the file system it lives on, and the time now.
 */
export function sweepStaleSandboxes({ fileSystem, now, root }: SandboxSweep): void {
	if (!fileSystem.existsSync(root)) {
		return;
	}

	const staleBefore = now - STALE_AFTER_MS;
	for (const entry of fileSystem.readdirSync(root)) {
		if (!entry.startsWith(SANDBOX_PREFIX)) {
			continue;
		}

		// `throwIfNoEntry` because the same concurrent run can take its
		// sandbox away between the listing and this line, and an ENOENT
		// raised here would fail the whole run from `globalSetup`.
		const entryPath = path.join(root, entry);
		const stats = fileSystem.statSync(entryPath, { throwIfNoEntry: false });
		if (stats !== undefined && stats.mtimeMs < staleBefore) {
			fileSystem.rmSync(entryPath, { force: true, recursive: true });
		}
	}
}
