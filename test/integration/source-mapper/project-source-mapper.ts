import process from "node:process";
import { onTestFinished, vi } from "vitest";

import type { Backend, ExecuteResult } from "#src/index.ts";
import { runProjectsAsync } from "#src/index.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

export type SourceMapper = NonNullable<ExecuteResult["sourceMapper"]>;

const EMPTY_RUN = JSON.stringify({
	numFailedTests: 0,
	numPassedTests: 0,
	numPendingTests: 0,
	numTotalTests: 0,
	startTime: 0,
	success: true,
	testResults: [],
});

export async function buildProjectSourceMapperAsync(rootDirectory: string): Promise<SourceMapper> {
	const previous = process.cwd();
	process.chdir(rootDirectory);
	onTestFinished(() => {
		process.chdir(previous);
	});

	const backend: Backend = {
		kind: "open-cloud",
		placeInput: "built",
		runTestsAsync: vi.fn<Backend["runTestsAsync"]>().mockResolvedValue({
			rawResults: [{ entry: { elapsedMs: 0, jestOutput: EMPTY_RUN } }],
			timing: { executionMs: 0, uploadMs: 0 },
		}),
	};
	const { results } = await runProjectsAsync({
		backend,
		deferFormatting: true,
		projects: [{ config: createResolvedConfig({ rootDir: rootDirectory }), testFiles: [] }],
		startTime: 0,
		version: "0.0.0",
	});
	const sourceMapper = results[0]?.sourceMapper;
	if (sourceMapper === undefined) {
		throw new Error(`No source mapper was built for ${rootDirectory}`);
	}

	return sourceMapper;
}
