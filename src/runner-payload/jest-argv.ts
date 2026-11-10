import type { Argv } from "@rbxts/jest/src/config";

import type { SnapshotFormatOptions } from "../config/config-types.ts";
import { JEST_ARGV_KEYS } from "../config/options.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RunnerArgv } from "../protocol/runner.ts";
import { toRobloxTestMatch, toRobloxTestPathIgnorePatterns } from "../utils/test-file-kind.ts";

/** Input to `buildJestArgv`. */
export interface JestArgvInput {
	/** Resolved config to translate. */
	config: ResolvedConfig;
	/** Have the runner report its phase timings; the run's `TIMING` setting. */
	runnerTiming?: boolean | undefined;
}

/** Jest's argv plus the `runner*` keys our own runner reads. */
export type JestArgv = Argv &
	RunnerArgv & {
		jestPath?: string;
		snapshotFormat?: SnapshotFormatOptions;
		/** Jest option `Argv` omits; `normalize` reads it. */
		testLocationInResults?: boolean;
		testMatch: Array<string>;
	};

/** A {@link JestArgv} that names its job's index in the request. */
export type IndexedJestArgv = JestArgv & Required<Pick<RunnerArgv, "runnerJobIndex">>;

/**
 * Translate a resolved config into the argv jest-roblox runs with.
 * @param options - Resolved config and the run's timing setting.
 * @returns Argv with Roblox-form test patterns and the Jest passthrough keys.
 */
export function buildJestArgv(options: JestArgvInput): JestArgv {
	const argv = jestOptionsOf(options);

	if (options.config.jestPath !== undefined) {
		argv.jestPath = options.config.jestPath;
	}

	if (options.runnerTiming === true) {
		argv.runnerTiming = true;
	}

	// The runner reads an absent budget as no deadline; zero asks for that.
	if (options.config.projectTimeout > 0) {
		argv.runnerTimeoutMs = options.config.projectTimeout;
	}

	if (options.config.collectCoverage) {
		argv.runnerCoverage = true;
	}

	if (options.config.collectPerTestCoverage === true) {
		argv.runnerPerTestCoverage = true;
		argv.testLocationInResults = true;
	}

	argv.reporters ??= [];
	return argv;
}

/**
 * The argv one job of a request runs with; the runner echoes the index on the
 * job's envelope entry.
 * @param argv - The job's argv.
 * @param jobIndex - Index of the job in the request.
 * @returns The argv naming its job.
 */
export function indexArgv(argv: JestArgv, jobIndex: number): IndexedJestArgv {
	return { ...argv, runnerJobIndex: jobIndex };
}

function jestOptionsOf(options: JestArgvInput): JestArgv {
	const { testMatch, testPathIgnorePatterns, ...config } = options.config;
	const argv: JestArgv = {
		testMatch: toRobloxTestMatch(testMatch),
		testPathIgnorePatterns: toRobloxTestPathIgnorePatterns(testPathIgnorePatterns),
	};
	for (const [key, value] of Object.entries(config)) {
		if (value !== undefined && JEST_ARGV_KEYS.has(key)) {
			Reflect.set(argv, key, value);
		}
	}

	return argv;
}
