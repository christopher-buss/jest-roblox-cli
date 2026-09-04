import type { Argv } from "@rbxts/jest/src/config";

import process from "node:process";

import {
	JEST_ARGV_EXCLUDED_KEYS,
	type ResolvedConfig,
	type SnapshotFormatOptions,
} from "./config/schema.ts";
import template from "./test-runner.bundled.luau";

const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;

/**
 * Jest's argv plus the four keys our own runner reads, declared here so the
 * contract is written down on both sides (`luau/runner.luau` has the matching
 * `Config` type). None is a Jest option, and the `runner` prefix keeps them
 * clear of Jest's own keys in the same flat object — Jest has its own
 * `coverage`. `runner.luau` deletes the three flags before `Jest.runCLI`.
 */
export type JestArgv = Argv & {
	jestPath?: string;
	runnerCoverage?: boolean;
	runnerPerTestCoverage?: boolean;
	runnerTimeoutMs?: number;
	runnerTiming?: boolean;
	snapshotFormat?: SnapshotFormatOptions;
	/**
	 * A Jest option jest-roblox's `Argv` type omits; its `normalize` reads it.
	 */
	testLocationInResults?: boolean;
	testMatch: Array<string>;
};

export interface JestArgvInput {
	config: ResolvedConfig;
	testFiles: Array<string>;
}

export function buildJestArgv(options: JestArgvInput): JestArgv {
	// Jest passthrough keys are copied by name, so they land via `Reflect.set`
	// on an already-typed argv rather than being asserted onto one afterwards.
	const { testMatch, ...config } = options.config;
	const argv: JestArgv = {
		testMatch: testMatch.map((pattern) => pattern.replace(TS_OR_LUAU_EXTENSION, "")),
	};
	for (const [key, value] of Object.entries(config)) {
		if (value !== undefined && !JEST_ARGV_EXCLUDED_KEYS.has(key)) {
			Reflect.set(argv, key, value);
		}
	}

	if (options.config.jestPath !== undefined) {
		argv.jestPath = options.config.jestPath;
	}

	if (process.env["TIMING"] !== undefined) {
		argv.runnerTiming = true;
	}

	// Omitted at zero rather than forwarded as one: the runner reads an absent
	// budget as "no deadline", and zero is how a config asks for that.
	if (options.config.projectTimeout > 0) {
		argv.runnerTimeoutMs = options.config.projectTimeout;
	}

	if (options.config.collectCoverage) {
		argv.runnerCoverage = true;
	}

	if (options.config.collectPerTestCoverage === true) {
		argv.runnerPerTestCoverage = true;
		// Attribution records where each test is declared, so a consumer can
		// tell a spec edit that touched a test from one that did not. Jest only
		// reads the call site when asked.
		argv.testLocationInResults = true;
	}

	argv.reporters ??= [];
	return argv;
}

/**
 * The Luau task script for one bucket of configs.
 *
 * @param options - The configs to run, and the test files each selects.
 * @param testProgressMapId - Where the runtime heartbeats the test it is on,
 *   so a run that never comes back can still be told which test it died
 *   inside. Omitted rather than nulled when there is none, so a run without
 *   one generates the byte-for-byte script it always did.
 * @returns The script to submit.
 */
export function generateTestScript(
	options: Array<JestArgvInput> | JestArgvInput,
	testProgressMapId?: string,
): string {
	const inputs = Array.isArray(options) ? options : [options];
	const configs = inputs.map((input) => buildJestArgv(input));
	const payload =
		testProgressMapId === undefined
			? { configs }
			: { configs, progress: { mapId: testProgressMapId } };
	return template.replace("__CONFIG_JSON__", () => JSON.stringify(payload));
}
