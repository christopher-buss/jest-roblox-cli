import { fromExact } from "@total-typescript/shoehorn";

import type { StudioDispatch } from "#src/backends/plugin-payload.ts";
import type { RawCoverageData } from "#src/coverage-data/coverage-types.ts";
import type { ConfiguredJob } from "#src/executor/executor-types.ts";
import type { JestResult } from "#src/types/jest-result-types.ts";

/** Jobs that still carry the config the request's run settings come from. */
export interface ConfiguredJobs {
	jobs: [ConfiguredJob, ...Array<ConfiguredJob>];
}

/**
 * A Studio dispatch whose run settings are the first job's config.
 * @param request - Jobs and any dispatch fields to override.
 * @returns The dispatch, a workspace one when a job names a package.
 */
export function studioRequest(
	request: ConfiguredJobs & Partial<StudioDispatch>,
): ConfiguredJobs & StudioDispatch {
	return {
		bail: false,
		runSettings: request.jobs[0].config,
		vmParallel: undefined,
		workspace: request.jobs.some((entry) => entry.pkg !== undefined),
		...request,
	};
}

/**
 * A dispatch whose run settings carry another run timeout.
 * @template Request - Dispatch type, kept on the copy.
 * @param request - Dispatch to copy.
 * @param timeout - Run timeout in milliseconds.
 * @returns The dispatch with the timeout set.
 */
export function timed<Request extends StudioDispatch>(request: Request, timeout: number): Request {
	return { ...request, runSettings: { ...request.runSettings, timeout } };
}

/**
 * A passing Jest result as the plugin sends it.
 * @param overrides - Result fields, and any runner coverage, to change.
 * @returns The result as JSON.
 */
export function successResult(
	overrides: Partial<JestResult> & { runner?: { coverage?: RawCoverageData } } = {},
): string {
	return JSON.stringify(
		fromExact<JestResult>({
			numFailedTests: 0,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [],
			...overrides,
		}),
	);
}

/**
 * A result envelope whose entries take their job index from their position.
 * @param entries - The entries, each with its Jest output.
 * @param flags - Whether the plugin deferred the run.
 * @returns The envelope as JSON.
 */
export function envelope(
	entries: Array<{
		elapsedMs?: number;
		gameOutput?: string;
		jestOutput: string;
		jobIndex?: number;
	}>,
	flags: { deferred?: boolean } = {},
): string {
	return JSON.stringify({
		...flags,
		entries: entries.map((entry, jobIndex) => ({ jobIndex, ...entry })),
	});
}
