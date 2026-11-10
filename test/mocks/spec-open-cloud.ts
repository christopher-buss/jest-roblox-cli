import type { ScriptResult } from "@isentinel/roblox-runner";

import process from "node:process";
import { onTestFinished, vi } from "vitest";

export interface StderrCapture {
	restore: () => void;
	writes: Array<string>;
}

export interface EnvelopeEntry {
	elapsedMs?: number;
	gameOutput?: string;
	jestOutput: string;
	/** Defaults to the entry's position. */
	jobIndex?: number;
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
	return JSON.stringify({
		...options,
		entries: entries.map((entry, jobIndex) => ({ jobIndex, ...entry })),
	});
}

export function scriptResult(jestOutput: string, gameOutput = "[]"): ScriptResult {
	return { durationMs: 5, outputs: [jestOutput, gameOutput] };
}

const PACKAGE_JOB_INDEX: Readonly<Record<string, number>> = {
	alpha: 0,
	beta: 1,
	delta: 3,
	epsilon: 4,
	gamma: 2,
	zeta: 5,
};

/**
 * The job index of a fixture package: its position in alpha, beta, gamma,
 * delta, epsilon, zeta.
 * @param packageName - One of the fixture package names.
 * @returns Where the package sits in that list.
 * @throws {@link Error} When the name is not a fixture package.
 */
export function packageJobIndex(packageName: string): number {
	const jobIndex = PACKAGE_JOB_INDEX[packageName];
	if (jobIndex === undefined) {
		throw new Error(`No job index for fixture package ${packageName}`);
	}

	return jobIndex;
}
