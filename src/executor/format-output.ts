import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { formatAgent } from "../formatters/agent.ts";
import { toFormatOptions } from "../formatters/format-options.ts";
import type { FormatOptions } from "../formatters/formatter.ts";
import { formatResult } from "../formatters/formatter.ts";
import { formatJson } from "../formatters/json.ts";
import { DEFAULT_MAX_FAILURES, findFormatterOptions, hasFormatter } from "../formatters/utils.ts";
import type { FormatOutputOptions } from "./types.ts";

interface ResolvedOutputPaths {
	gameOutput: string | undefined;
	outputFile: string | undefined;
}

export function formatExecuteOutput(options: FormatOutputOptions): string {
	const { config, result, sourceMapper, timing } = options;
	if (config.silent) {
		return "";
	}

	const paths = resolveOutputPaths(config);

	const agentOptions = findFormatterOptions(config.formatters ?? [], "agent");

	if (agentOptions !== undefined && !config.verbose) {
		return formatAgent(result, {
			gameOutput: paths.gameOutput,
			maxFailures: agentOptions.maxFailures ?? DEFAULT_MAX_FAILURES,
			outputFile: paths.outputFile,
			rootDir: config.rootDir,
			sourceMapper,
			typeErrorCount: options.typeErrorCount,
		});
	}

	if (hasFormatter(config.formatters, "json")) {
		return formatJson(result);
	}

	return formatResult(result, timing, buildResultOptions(options, paths));
}

function resolveOutputPaths(config: ResolvedConfig): ResolvedOutputPaths {
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
