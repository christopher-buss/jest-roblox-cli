import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import { type ExecuteResult, runProjects } from "../executor.ts";
import { hasFormatter, usesAgentFormatter } from "../formatters/utils.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import { classifyTestFiles, discoverTestFiles, resolveSetupFilePaths } from "./discovery.ts";
import type { RunOptions, SingleRunResult } from "./types.ts";

const VERSION: string = packageJson.version;

interface ExecuteRuntimeTestsOptions {
	cli: RunOptions["cli"];
	config: ResolvedConfig;
	testFiles: Array<string>;
	timing: TimingCollector;
	totalFiles: number;
}

export async function runSingleProject(options: RunOptions): Promise<SingleRunResult> {
	const { cli } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	// Discover against the raw config: `discoverTestFiles` filters globbed FS
	// paths by the raw `testPathPattern` regex (FS namespace). Narrowing for the
	// Luau runner happens after discovery, driven by the resolved file set.
	// Shallow-clone so `resolveSetupFilePaths` doesn't mutate the caller's
	// config.
	const baseConfig = { ...options.config };
	timing.profile("resolveSetupFilePaths", () => {
		resolveSetupFilePaths(baseConfig);
	});
	const discovery = timing.profile("discoverTestFiles", () => {
		return discoverTestFiles(baseConfig, cli.files);
	});

	if (discovery.files.length === 0) {
		if (baseConfig.passWithNoTests) {
			return { mode: "single", preCoverageMs: 0 };
		}

		console.error("No test files found");
		return { mode: "single", preCoverageMs: 0, validationExitCode: 2 };
	}

	const { runtimeFiles, typeTestFiles } = timing.profile("classifyTestFiles", () => {
		return classifyTestFiles(discovery.files, baseConfig);
	});

	const filterActive = (cli.files?.length ?? 0) > 0 || baseConfig.testPathPattern !== undefined;
	const config = timing.profile("narrowForLuauRun", () => {
		return narrowForLuauRun(baseConfig, runtimeFiles, filterActive);
	});

	if (typeTestFiles.length === 0 && runtimeFiles.length === 0) {
		if (config.passWithNoTests) {
			return { mode: "single", preCoverageMs: 0 };
		}

		console.error("No test files found for the selected mode");
		return { mode: "single", preCoverageMs: 0, validationExitCode: 2 };
	}

	let preCoverageMs = 0;
	let effectiveConfig = config;
	if (config.collectCoverage && !config.typecheckOnly && runtimeFiles.length > 0) {
		const preCoverageStart = Date.now();
		const { placeFile } = timing.profile("prepareCoverage", () => prepareCoverage(config));
		preCoverageMs = Date.now() - preCoverageStart;
		effectiveConfig = { ...config, placeFile } satisfies ResolvedConfig;
	}

	const typecheckResult =
		typeTestFiles.length > 0
			? timing.profile("runTypecheck", () => {
					return runTypecheck({
						files: typeTestFiles,
						rootDir: effectiveConfig.rootDir,
						tsconfig: effectiveConfig.typecheckTsconfig,
					});
				})
			: undefined;

	const runtimeResult =
		runtimeFiles.length > 0
			? await executeRuntimeTests({
					cli,
					config: effectiveConfig,
					testFiles: runtimeFiles,
					timing,
					totalFiles: discovery.totalFiles,
				})
			: undefined;

	return { mode: "single", preCoverageMs, runtimeResult, typecheckResult };
}

async function executeRuntimeTests(options: ExecuteRuntimeTestsOptions): Promise<ExecuteResult> {
	const { cli, config, testFiles, timing, totalFiles } = options;
	const useDefaultFormatter =
		!config.silent &&
		!usesAgentFormatter(config.formatters, config.verbose) &&
		!hasFormatter(config.formatters, "json");
	if (useDefaultFormatter && testFiles.length !== totalFiles) {
		process.stderr.write(
			`Running ${String(testFiles.length)} of ${String(totalFiles)} test files\n`,
		);
	}

	const backend = await timing.profileAsync("resolveBackend", async () => {
		return resolveBackend(cli, config);
	});

	try {
		const { results } = await timing.profileAsync("runProjects", async () => {
			return runProjects({
				backend,
				deferFormatting: true,
				projects: [{ config, testFiles }],
				startTime: Date.now(),
				timing,
				version: VERSION,
			});
		});
		// eslint-disable-next-line ts/no-non-null-assertion -- length-1 invariant
		return results[0]!;
	} finally {
		await backend.close?.();
	}
}
