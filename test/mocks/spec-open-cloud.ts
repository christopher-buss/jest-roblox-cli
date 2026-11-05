import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";
import { onTestFinished, vi } from "vitest";

import type { ProjectJob } from "../../src/backends/interface.ts";

export interface StderrCapture {
	restore: () => void;
	writes: Array<string>;
}

export interface EnvelopeEntry {
	elapsedMs?: number;
	gameOutput?: string;
	jestOutput: string;
	pkg?: string;
	project?: string;
}

export function captureStderr(): StderrCapture {
	const writes: Array<string> = [];
	const spy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: Parameters<typeof process.stderr.write>[0]) => {
			writes.push(String(chunk));
			return true;
		});

	return {
		restore: () => {
			spy.mockRestore();
		},
		writes,
	};
}

export function captureStderrForTest(): Array<string> {
	const { restore, writes } = captureStderr();
	onTestFinished(restore);
	return writes;
}

export function envelope(
	entries: Array<EnvelopeEntry>,
	options: { bailed?: boolean; deferred?: boolean } = {},
): string {
	return JSON.stringify({ ...options, entries });
}

export function scriptResult(jestOutput: string, gameOutput = "[]"): ScriptResult {
	return { durationMs: 5, outputs: [jestOutput, gameOutput] };
}

export function scriptNaming(jobs: ReadonlyArray<ProjectJob>): string {
	return `entries:${jobs.map((entry) => entry.displayName).join(",")}`;
}
