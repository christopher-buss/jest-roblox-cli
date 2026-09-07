import { defaultFormatters } from "./default-formatters.ts";
import type { CliOptions, FormatterEntry, ResolvedConfig } from "./schema.ts";

type CoverageKey =
	| "collectCoverage"
	| "collectCoverageFrom"
	| "coverageCache"
	| "coverageDirectory"
	| "coverageReporters";

export function mergeCliWithConfig(cli: CliOptions, config: ResolvedConfig): ResolvedConfig {
	return {
		...config,
		...resolveCoverage(cli, config),
		backend: cli.backend ?? config.backend,
		binaryInput: cli.binaryInput ?? config.binaryInput,
		color: cli.color ?? config.color,
		experimentalVmParallel: cli.experimentalVmParallel,
		formatters: resolveFormatters(cli, config),
		gameOutput: cli.gameOutput ?? config.gameOutput,
		outputFile: cli.outputFile ?? config.outputFile,
		parallel: cli.parallel ?? config.parallel,
		passWithNoTests: cli.passWithNoTests ?? config.passWithNoTests,
		port: cli.port ?? config.port,
		rojoProject: cli.rojoProject ?? config.rojoProject,
		setupFiles: cli.setupFiles ?? config.setupFiles,
		setupFilesAfterEnv: cli.setupFilesAfterEnv ?? config.setupFilesAfterEnv,
		showLuau: cli.showLuau ?? config.showLuau,
		silent: cli.silent ?? config.silent,
		sourceMap: cli.sourceMap ?? config.sourceMap,
		studioPath: cli.studioPath ?? config.studioPath,
		testNamePattern: cli.testNamePattern ?? config.testNamePattern,
		testPathPattern: cli.testPathPattern ?? config.testPathPattern,
		timeout: cli.timeout ?? config.timeout,
		updateSnapshot: cli.updateSnapshot ?? config.updateSnapshot,
		uploadCache: cli.uploadCache ?? config.uploadCache,
		verbose: cli.verbose ?? config.verbose,
	};
}

function resolveCoverage(
	cli: CliOptions,
	config: ResolvedConfig,
): Pick<ResolvedConfig, CoverageKey> {
	return {
		collectCoverage: cli.collectCoverage ?? config.collectCoverage,
		collectCoverageFrom: cli.collectCoverageFrom ?? config.collectCoverageFrom,
		coverageCache: cli.coverageCache ?? config.coverageCache,
		coverageDirectory: cli.coverageDirectory ?? config.coverageDirectory,
		coverageReporters: cli.coverageReporters ?? config.coverageReporters,
	};
}

function resolveFormatters(cli: CliOptions, config: ResolvedConfig): Array<FormatterEntry> {
	return cli.formatters ?? config.formatters ?? defaultFormatters();
}
