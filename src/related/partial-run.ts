import * as path from "node:path";

import type { CliOptions } from "../config/resolved-config.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { ChangedFilesOptions } from "./changed-files.ts";
import { readChangedFiles } from "./changed-files.ts";

/**
 * The source files a Partial Run selects from: the files changed since a ref
 * (`--changed [since]`), or the given files (`related <files...>`).
 */
export type PartialRun =
	| { files: ReadonlyArray<string>; kind: "changed"; since: string }
	| { files: ReadonlyArray<string>; kind: "related" };

/** Inputs of {@link resolvePartialRun}. */
export interface PartialRunInput {
	/** Parsed command-line options. */
	cli: Pick<CliOptions, "changed" | "related">;
	/** Run root the related files resolve against and git runs in. */
	rootDirectory: string;
	/** Runs git for `--changed`. */
	seams: { childProcess: ChangedFilesOptions["childProcess"] };
	/** Profiler the git read reports its phase to. */
	timing: TimingCollector;
}

/**
 * Turn `--changed [since]` or `related <files...>` into the absolute source
 * files the run selects from. `--changed` reads them from git in the
 * `readChangedFiles` phase.
 *
 * @param input - CLI options, run root, git runner and profiler.
 * @returns The Partial Run, or `undefined` on a full run.
 */
export function resolvePartialRun({
	cli,
	rootDirectory,
	seams,
	timing,
}: PartialRunInput): PartialRun | undefined {
	const { changed: since, related } = cli;
	if (since !== undefined) {
		const files = timing.profile("readChangedFiles", () => {
			return readChangedFiles({
				childProcess: seams.childProcess,
				cwd: rootDirectory,
				since,
			});
		});
		return { files, kind: "changed", since };
	}

	return related === undefined
		? undefined
		: { files: related.map((file) => path.resolve(rootDirectory, file)), kind: "related" };
}
