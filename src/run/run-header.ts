import process from "node:process";

import { isDefaultHumanFormatter } from "../config/formatter-selection.ts";
import type { FormatterEntry } from "../config/formatter-selection.ts";
import { formatRunHeader } from "../formatters/summary.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import { createStyles } from "../terminal/palette.ts";

/** Inputs of {@link emitRunHeader}. */
export interface RunHeaderInput {
	/** Whether the header shows that coverage is on. */
	collectCoverage?: boolean | undefined;
	/** Whether output is colorized. */
	color: boolean;
	/** Formatters of the run; the header prints only for the human one. */
	formatters: Array<FormatterEntry> | undefined;
	/** Revealed here: the stage block may only follow the header. */
	progress: RunProgress;
	/** Root directory the header names. */
	rootDir: string;
	/** Whether to suppress output. */
	silent: boolean | undefined;
	/** Whether to print verbose output. */
	verbose: boolean | undefined;
	/** CLI version the header names. */
	version: string;
}

/**
 * Print the run header to stdout, only for the default human formatter.
 * @param input - Header fields, formatter gate and the progress to reveal.
 */
export function emitRunHeader(input: RunHeaderInput): void {
	if (!isDefaultHumanFormatter(input)) {
		return;
	}

	process.stdout.write(
		formatRunHeader(
			{
				collectCoverage: input.collectCoverage,
				rootDir: input.rootDir,
				version: input.version,
			},
			createStyles(input.color),
		),
	);
	input.progress.reveal({ color: input.color });
}
