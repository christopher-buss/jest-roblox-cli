import { embedConfigJson } from "../protocol/long-string.ts";
import template from "../test-runner.bundled.luau";
import type { IndexedJestArgv } from "./jest-argv.ts";

/**
 * The Luau task script for one bucket of configs.
 *
 * @param configs - The argv of each config to run, each naming its job.
 * @returns The script to submit.
 */
export function generateTestScript(configs: ReadonlyArray<IndexedJestArgv>): string {
	return embedConfigJson(template, JSON.stringify({ configs }));
}
