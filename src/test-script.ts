import type { Argv } from "@rbxts/jest/src/config";

import process from "node:process";

import {
	JEST_ARGV_EXCLUDED_KEYS,
	type ResolvedConfig,
	type SnapshotFormatOptions,
} from "./config/schema.ts";
import template from "./test-runner.bundled.luau";

const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;

export type JestArgv = Argv & {
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
	const argv: JestArgv = { testMatch: [] };
	for (const [key, value] of Object.entries(options.config)) {
		if (value !== undefined && !JEST_ARGV_EXCLUDED_KEYS.has(key)) {
			Reflect.set(argv, key, value);
		}
	}

	if (options.config.jestPath !== undefined) {
		Reflect.set(argv, "jestPath", options.config.jestPath);
	}

	if (process.env["TIMING"] !== undefined) {
		Reflect.set(argv, "_timing", true);
	}

	if (options.config.collectCoverage) {
		Reflect.set(argv, "_coverage", true);
	}

	if (options.config.collectPerTestCoverage === true) {
		Reflect.set(argv, "_perTestCoverage", true);
	}

	argv.reporters ??= [];
	argv.testMatch = options.config.testMatch.map((pattern) => {
		return pattern.replace(TS_OR_LUAU_EXTENSION, "");
	});
	return argv;
}

export function generateTestScript(options: Array<JestArgvInput> | JestArgvInput): string {
	const inputs = Array.isArray(options) ? options : [options];
	const configs = inputs.map((input) => buildJestArgv(input));
	return template.replace("__CONFIG_JSON__", () => JSON.stringify({ configs }));
}
