import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import { narrowConfigByFiles } from "../config/narrow-by-files.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import { type ExecuteResult, runProjects } from "../executor.ts";
import { hasFormatter, usesAgentFormatter } from "../formatters/utils.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import { classifyTestFiles, discoverTestFiles, resolveSetupFilePaths } from "./discovery.ts";
import type { RunOptions, SingleRunResult } from "./types.ts";

const VERSION: string = packageJson.version;

export async function runSingleProject(options: RunOptions): Promise<SingleRunResult> {
	const { cli } = options;
	const config = narrowConfigByFiles(options.config, cli.files ?? []);
	resolveSetupFilePaths(config);
	const discovery = discoverTestFiles(config, cli.files);

	if (discovery.files.length === 0) {
		if (config.passWithNoTests) {
			return { mode: "single", preCoverageMs: 0 };
		}

		console.error("No test files found");
		return { mode: "single", preCoverageMs: 0, validationExitCode: 2 };
	}

	const { runtimeFiles, typeTestFiles } = classifyTestFiles(discovery.files, config);

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
		const { placeFile } = prepareCoverage(config);
		preCoverageMs = Date.now() - preCoverageStart;
		effectiveConfig = { ...config, placeFile } satisfies ResolvedConfig;
	}

	const typecheckResult =
		typeTestFiles.length > 0
			? runTypecheck({
					files: typeTestFiles,
					rootDir: effectiveConfig.rootDir,
					tsconfig: effectiveConfig.typecheckTsconfig,
				})
			: undefined;

	const runtimeResult =
		runtimeFiles.length > 0
			? await executeRuntimeTests(
					options,
					effectiveConfig,
					runtimeFiles,
					discovery.totalFiles,
				)
			: undefined;

	return { mode: "single", preCoverageMs, runtimeResult, typecheckResult };
}

async function executeRuntimeTests(
	options: RunOptions,
	config: ResolvedConfig,
	testFiles: Array<string>,
	totalFiles: number,
): Promise<ExecuteResult> {
	const useDefaultFormatter =
		!config.silent &&
		!usesAgentFormatter(config.formatters, config.verbose) &&
		!hasFormatter(config.formatters, "json");
	if (useDefaultFormatter && testFiles.length !== totalFiles) {
		process.stderr.write(
			`Running ${String(testFiles.length)} of ${String(totalFiles)} test files\n`,
		);
	}

	const backend = await resolveBackend(options.cli, config);

	try {
		const { results } = await runProjects({
			backend,
			deferFormatting: true,
			projects: [{ config, testFiles }],
			startTime: Date.now(),
			version: VERSION,
		});
		// eslint-disable-next-line ts/no-non-null-assertion -- length-1 invariant
		return results[0]!;
	} finally {
		await backend.close?.();
	}
}
