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
	runnerTiming?: boolean;
	snapshotFormat?: SnapshotFormatOptions;
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

	if (options.config.collectCoverage) {
		argv.runnerCoverage = true;
	}

	if (options.config.collectPerTestCoverage === true) {
		argv.runnerPerTestCoverage = true;
	}

	argv.reporters ??= [];
	return argv;
}

export function generateTestScript(options: Array<JestArgvInput> | JestArgvInput): string {
	const inputs = Array.isArray(options) ? options : [options];
	const configs = inputs.map((input) => buildJestArgv(input));
	return template.replace("__CONFIG_JSON__", () => JSON.stringify({ configs }));
}
