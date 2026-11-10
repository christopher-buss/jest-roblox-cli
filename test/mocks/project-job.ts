import { fromAny } from "@total-typescript/shoehorn";

import type { Except } from "type-fest";

import type { ConfiguredJob } from "#src/executor/executor-types.ts";

/**
 * A job whose argv defaults to its whole config, so a script built from it
 * carries every config key a spec sets.
 * @param job - The job without its argv, or with an argv of its own.
 * @returns The job with its argv.
 */
export function projectJob(
	job: Except<ConfiguredJob, "argv"> & Partial<Pick<ConfiguredJob, "argv">>,
): ConfiguredJob {
	return { ...job, argv: job.argv ?? fromAny({ ...job.config }) };
}
