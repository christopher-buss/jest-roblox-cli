import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";

import { sweepStaleSandboxes } from "#test/harness/sandbox-root.ts";

/**
 * Vitest `globalSetup` for the `e2e` project. Runs once, before any spec file
 * starts, which is the only point in a run where nothing this project owns is
 * in flight.
 * @param project - The project whose specs read the tool probes.
 */
export default function globalSetup({ provide }: TestProject): void {
	sweepStaleSandboxes();
	provide("rojoOnPath", toolRuns("rojo"));
}

function toolRuns(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "pipe", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}
