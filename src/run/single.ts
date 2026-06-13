import { performance } from "node:perf_hooks";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import { applyExcludes } from "../config/apply-excludes.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { CoverageArtifacts } from "../coverage-pipeline/build-manifest.ts";
import {
	prepareCoverage,
	resolveLuauRoots,
	toCoverageArtifacts,
} from "../coverage-pipeline/prepare.ts";
import { type ExecuteResult, runProjects } from "../executor.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import type { JestResult } from "../types/jest-result.ts";
import { classifyTestFiles, discoverTestFiles, resolveSetupFilePaths } from "./discovery.ts";
import { toSingleProjectManifest } from "./manifest-projects.ts";
import { loadRojoTree } from "./multi.ts";
import { emitRunHeader } from "./run-header.ts";
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
	const typecheck = resolveTypecheckConfig({
		cli: { enabled: cli.typecheck, only: cli.typecheckOnly, tsconfig: cli.typecheckTsconfig },
		root: baseConfig.typecheck,
	});
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

	const { runtimeFiles: classifiedRuntime, typeTestFiles: classifiedTypeTests } = timing.profile(
		"classifyTestFiles",
		() => classifyTestFiles(discovery.files, typecheck),
	);

	// `test.exclude` subtracts from Runtime Test discovery;
	// `test.typecheck.exclude` from the Type Test set. Both skip explicit
	// positionals (user-chosen absolute paths), mirroring the per-project
	// excludes in multi mode.
	const isPositional = (cli.files?.length ?? 0) > 0;
	const runtimeFiles = isPositional
		? classifiedRuntime
		: applyExcludes(classifiedRuntime, baseConfig.exclude);
	const typeTestFiles = isPositional
		? classifiedTypeTests
		: applyExcludes(classifiedTypeTests, typecheck.exclude);

	const filterActive = isPositional || baseConfig.testPathPattern !== undefined;
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
	let coverageArtifacts: CoverageArtifacts | undefined;
	if (config.collectCoverage && !typecheck.only && runtimeFiles.length > 0) {
		const preCoverageStart = Date.now();
		const coverage = timing.profile("prepareCoverage", () => prepareCoverage(config));
		preCoverageMs = Date.now() - preCoverageStart;
		effectiveConfig = { ...config, placeFile: coverage.placeFile } satisfies ResolvedConfig;
		coverageArtifacts = toCoverageArtifacts(
			coverage,
			toSingleProjectManifest(config, resolveLuauRoots(config), loadRojoTree(config)),
		);
	}

	// Run the typecheck pass concurrently with the runtime so the local
	// CPU-bound tsgo work overlaps the network-bound Open Cloud upload/poll.
	// `rootDir` is invariant under coverage (only `placeFile` changes), so the
	// pass can run alongside a coverage-built runtime. The pass times itself
	// with a plain clock rather than `timing.profile` — the collector's LIFO
	// stack would corrupt if both branches profiled concurrently — and the
	// span is recorded at root after the barrier.
	let typecheckMs = 0;
	const typecheckPass =
		typeTestFiles.length > 0
			? (async (): Promise<JestResult> => {
					const start = performance.now();
					try {
						return await runTypecheck({
							files: typeTestFiles,
							ignoreSourceErrors: typecheck.ignoreSourceErrors,
							rootDir: effectiveConfig.rootDir,
							spawnTimeout: typecheck.spawnTimeout,
							tsconfig: typecheck.tsconfig,
						});
					} finally {
						typecheckMs = performance.now() - start;
					}
				})()
			: Promise.resolve(undefined);

	const runtimePass =
		runtimeFiles.length > 0
			? executeRuntimeTests({
					cli,
					config: effectiveConfig,
					testFiles: runtimeFiles,
					timing,
					totalFiles: discovery.totalFiles,
				})
			: Promise.resolve(undefined);

	const [typecheckResult, runtimeResult] = await Promise.all([typecheckPass, runtimePass]);
	if (typeTestFiles.length > 0) {
		timing.record("runTypecheck", typecheckMs);
	}

	return { coverageArtifacts, mode: "single", preCoverageMs, runtimeResult, typecheckResult };
}

async function executeRuntimeTests(options: ExecuteRuntimeTestsOptions): Promise<ExecuteResult> {
	const { cli, config, testFiles, timing, totalFiles } = options;
	const useDefaultFormatter = isDefaultHumanFormatter(config);
	emitRunHeader({
		collectCoverage: config.collectCoverage,
		color: config.color,
		formatters: config.formatters,
		rootDir: config.rootDir,
		silent: config.silent,
		verbose: config.verbose,
		version: VERSION,
	});
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
