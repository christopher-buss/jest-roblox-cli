import process from "node:process";
import { isAgent } from "std-env";

import type { CliOptions, FormatterEntry, ResolvedConfig } from "./schema.ts";

export function mergeCliWithConfig(cli: CliOptions, config: ResolvedConfig): ResolvedConfig {
	return {
		...config,
		backend: cli.backend ?? config.backend,
		cache: cli.cache ?? config.cache,
		collectCoverage: cli.collectCoverage ?? config.collectCoverage,
		collectCoverageFrom: cli.collectCoverageFrom ?? config.collectCoverageFrom,
		color: cli.color ?? config.color,
		coverageDirectory: cli.coverageDirectory ?? config.coverageDirectory,
		coverageReporters: cli.coverageReporters ?? config.coverageReporters,
		formatters: resolveFormatters(cli, config),
		gameOutput: cli.gameOutput ?? config.gameOutput,
		outputFile: cli.outputFile ?? config.outputFile,
		parallel: cli.parallel ?? config.parallel,
		passWithNoTests: cli.passWithNoTests ?? config.passWithNoTests,
		pollInterval: cli.pollInterval ?? config.pollInterval,
		port: cli.port ?? config.port,
		rojoProject: cli.rojoProject ?? config.rojoProject,
		setupFiles: cli.setupFiles ?? config.setupFiles,
		setupFilesAfterEnv: cli.setupFilesAfterEnv ?? config.setupFilesAfterEnv,
		showLuau: cli.showLuau ?? config.showLuau,
		silent: cli.silent ?? config.silent,
		sourceMap: cli.sourceMap ?? config.sourceMap,
		testNamePattern: cli.testNamePattern ?? config.testNamePattern,
		testPathPattern: cli.testPathPattern ?? config.testPathPattern,
		timeout: cli.timeout ?? config.timeout,
		typecheck: cli.typecheck ?? config.typecheck,
		typecheckOnly: cli.typecheckOnly ?? config.typecheckOnly,
		typecheckTsconfig: cli.typecheckTsconfig ?? config.typecheckTsconfig,
		updateSnapshot: cli.updateSnapshot ?? config.updateSnapshot,
		verbose: cli.verbose ?? config.verbose,
	};
}

function resolveFormatters(cli: CliOptions, config: ResolvedConfig): Array<FormatterEntry> {
	const explicit = cli.formatters ?? config.formatters;
	if (explicit !== undefined) {
		return explicit;
	}

	const defaults: Array<FormatterEntry> = isAgent ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}
