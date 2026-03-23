import type { Argv } from "@rbxts/jest/src/config";

import process from "node:process";

import type { BackendOptions } from "./backends/interface.ts";
import { ROOT_ONLY_KEYS, type SnapshotFormatOptions } from "./config/schema.ts";
import template from "./test-runner.bundled.luau";

export type JestArgv = Argv & {
	snapshotFormat?: SnapshotFormatOptions;
	testMatch: Array<string>;
};

export function buildJestArgv(options: BackendOptions): JestArgv {
	const argv: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options.config)) {
		if (!ROOT_ONLY_KEYS.has(key) && value !== undefined) {
			argv[key] = value;
		}
	}

	if (options.config.jestPath !== undefined) {
		argv["jestPath"] = options.config.jestPath;
	}

	if (process.env["TIMING"] !== undefined) {
		argv["_timing"] = true;
	}

	if (options.config.collectCoverage) {
		argv["_coverage"] = true;
	}

	return {
		...argv,
		reporters: argv["reporters"] ?? [],
		testMatch: options.config.testMatch.map((pattern) =>
			pattern.replace(/\.(tsx?|luau?)$/, ""),
		),
	} as JestArgv;
}

export function generateTestScript(options: BackendOptions): string {
	const config = buildJestArgv(options);
	return template.replace("__CONFIG_JSON__", () => JSON.stringify(config));
}
