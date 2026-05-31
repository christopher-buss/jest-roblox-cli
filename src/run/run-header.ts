import process from "node:process";

import type { FormatterEntry } from "../config/schema.ts";
import { formatRunHeader } from "../formatters/formatter.ts";
import { isDefaultHumanFormatter } from "../formatters/utils.ts";

export interface RunHeaderInput {
	collectCoverage?: boolean;
	color: boolean;
	formatters: Array<FormatterEntry> | undefined;
	rootDir: string;
	silent: boolean | undefined;
	verbose: boolean | undefined;
	version: string;
}

/**
 * Print the ` RUN  vX.Y  <rootDir>` header to stdout at the moment a run begins
 * (right before the backend uploads), so the CLI doesn't look stalled while it
 * waits for remote results. The end-of-run formatters no longer emit it.
 *
 * Self-gates to the default human formatter: nothing is written under
 * `--silent`, `--formatters json`, or `--formatters agent` (without
 * `--verbose`), which produce machine-readable output that must stay clean.
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
			verbose: input.verbose ?? false,
			version: input.version,
		}),
	);
}
