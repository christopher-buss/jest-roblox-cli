import process from "node:process";
import { onTestFinished, vi } from "vitest";

import type { Backend, ExecuteResult } from "#src/api.ts";
import { runProjectsAsync } from "#src/api.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

export type SourceMapper = NonNullable<ExecuteResult["sourceMapper"]>;

type RawRun = Awaited<ReturnType<Backend["runTestsAsync"]>>;

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
		runTestsAsync: vi.fn<(request: object) => Promise<RawRun>>().mockResolvedValue({
			rawResults: [{ entry: { jestOutput: EMPTY_RUN }, jobIndex: 0 }],
			timing: { executionMs: 0, uploadMs: 0 },
		}),
	};
	const config = createResolvedConfig({ rootDir: rootDirectory });
	const { results } = await runProjectsAsync({
		backend,
		projects: [{ config, testFiles: [] }],
		runSettings: config,
		startTime: 0,
		version: "0.0.0",
	});
	const sourceMapper = results[0]?.sourceMapper;
	if (sourceMapper === undefined) {
		throw new Error(`No source mapper was built for ${rootDirectory}`);
	}

	return sourceMapper;
}
