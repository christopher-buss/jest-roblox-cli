import fs, { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

import {
	SANDBOX_PREFIX,
	sweepStaleSandboxes as sweepStaleSandboxesIn,
} from "#test/setup/sandbox-sweep.ts";

/**
 * Where every fixture sandbox in this package is rooted, whichever project
 * builds it: the `e2e`, `live` and `integration` specs all reach
 * `createFixtureSandbox`. Inside the repo rather than `os.tmpdir()` on
 * purpose: a sandbox a failing test left behind stays readable beside the
 * fixture it was copied from.
 */
const SANDBOX_ROOT = path.resolve(import.meta.dirname, "..", "e2e", "cli", ".tmp");

export function createSandboxDirectory(): string {
	mkdirSync(SANDBOX_ROOT, { recursive: true });
	return mkdtempSync(path.join(SANDBOX_ROOT, SANDBOX_PREFIX));
}

export function sweepStaleSandboxes(): void {
	sweepStaleSandboxesIn({ fileSystem: fs, now: Date.now(), root: SANDBOX_ROOT });
}
