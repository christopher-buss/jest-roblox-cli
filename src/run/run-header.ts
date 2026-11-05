import process from "node:process";

import type { FormatterEntry } from "../config/schema.ts";
import { formatRunHeader } from "../formatters/formatter.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";
import type { RunProgress } from "../progress/reporter.ts";

/** Inputs of {@link emitRunHeader}. */
export interface RunHeaderInput {
	/** Whether the header shows that coverage is on. */
	collectCoverage?: boolean | undefined;
	/** Whether output is colorized. */
	color: boolean;
	/**
	 * Formatters of the run; the header prints only for the default human one.
	 */
	formatters: Array<FormatterEntry> | undefined;
	/**
	 * Revealed here: the header is the first line the stage block may follow.
	 */
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
 * Print the ` RUN  vX.Y  <rootDir>` header to stdout at the moment a run
 * begins (right before the backend uploads). The end-of-run formatters no
 * longer emit it.
 *
 * This is also where the stage block starts showing: the gate below is the
 * one that decides whether a human is reading, and a stage printed above the
 * header would read as output from the command before it.
 *
 * Self-gates to the default human formatter: nothing is written under
 * `--silent`, `--formatters json`, or `--formatters agent` (without
 * `--verbose`), which produce machine-readable output that must stay clean.
 *
 * @param input - Header fields, formatter gate and the progress to reveal.
 */
export function emitRunHeader(input: RunHeaderInput): void {
	if (!isDefaultHumanFormatter(input)) {
		return;
	}

	process.stdout.write(
		formatRunHeader({
			collectCoverage: input.collectCoverage,
			color: input.color,
			rootDir: input.rootDir,
			version: input.version,
		}),
	);
	input.progress.reveal({ color: input.color });
}
