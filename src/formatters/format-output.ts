import * as path from "node:path";

import { selectTerminalFormatter } from "../config/formatter-selection.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { TimingResult } from "../types/timing-types.ts";
import { formatAgent } from "./agent.ts";
import { toFormatOptions } from "./format-options.ts";
import { formatResult } from "./formatter.ts";
import { formatJson } from "./json.ts";
import type { FormatOptions } from "./shared.ts";

/** Inputs for `formatExecuteOutput`. */
export interface FormatOutputOptions {
	/** Resolved settings that select and drive the formatter. */
	config: Pick<
		ResolvedConfig,
		| "collectCoverage"
		| "color"
		| "formatters"
		| "gameOutput"
		| "outputFile"
		| "rootDir"
		| "showLuau"
		| "silent"
		| "slowTestThreshold"
		| "verbose"
	>;
	/** The Jest result to format. */
	result: JestResult;
	/** Count of snapshot writes that failed. */
	snapshotWriteFailures?: number | undefined;
	/** Maps Luau locations back to TypeScript source. */
	sourceMapper?: SourceMapper | undefined;
	/** Timing breakdown of the run. */
	timing: TimingResult;
	/** CLI version shown in the output. */
	version: string;
}

interface ResolvedOutputPaths {
	gameOutput: string | undefined;
	outputFile: string | undefined;
}

/**
 * Format one project's result for the terminal.
 * @param options - The result, config and timing to format.
 * @returns The formatted output, or an empty string when `config.silent` is set.
 */
export function formatExecuteOutput(options: FormatOutputOptions): string {
	const { config, result, sourceMapper, timing } = options;
	if (config.silent) {
		return "";
	}

	const paths = resolveOutputPaths(config);

	const formatter = selectTerminalFormatter(config);

	if (formatter.name === "agent") {
		return formatAgent(result, {
			gameOutput: paths.gameOutput,
			maxFailures: formatter.maxFailures,
			outputFile: paths.outputFile,
			rootDir: config.rootDir,
			sourceMapper,
		});
	}

	if (formatter.name === "json") {
		return formatJson(result, config.rootDir);
	}

	return formatResult({ options: buildResultOptions(options, paths), result, timing });
}

function resolveOutputPaths(config: FormatOutputOptions["config"]): ResolvedOutputPaths {
	return {
		gameOutput: config.gameOutput !== undefined ? path.resolve(config.gameOutput) : undefined,
		outputFile: config.outputFile !== undefined ? path.resolve(config.outputFile) : undefined,
	};
}

function buildResultOptions(
	{ config, snapshotWriteFailures, sourceMapper, version }: FormatOutputOptions,
	paths: ResolvedOutputPaths,
): FormatOptions {
	return {
		...toFormatOptions(config, version),
		gameOutput: paths.gameOutput,
		outputFile: paths.outputFile,
		snapshotWriteFailures,
		sourceMapper,
	};
}
