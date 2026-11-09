import { type } from "arktype";
import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** Inputs of {@link readChangedFiles}. */
export interface ChangedFilesOptions {
	/** Runs git. */
	childProcess: { execFileSync: GitRunner };
	/** Folder inside the git repository. */
	cwd: string;
	/**
	 * Ref the changes are read since; {@link UNCOMMITTED_REF} reads only the
	 * uncommitted changes.
	 */
	since: string;
}

type GitRunner = (
	file: string,
	args: ReadonlyArray<string>,
	options: ExecFileSyncOptionsWithStringEncoding,
) => string;

/** The `--changed` ref that reads only the uncommitted changes. */
export const UNCOMMITTED_REF = "HEAD";

const gitFailureSchema = type({ stderr: "string" });

/**
 * Read the files a `--changed [since]` run selects from, as vitest does: the
 * staged, unstaged and untracked files, plus the files committed between the
 * merge base of `since` and `HEAD`. Renames list both paths, so a moved
 * module still selects the tests that required its old path.
 *
 * @param options - Git runner, folder and ref.
 * @returns The absolute `/`-separated path of each changed file, once each.
 * @throws {Error} When the folder is in no git repository, or git fails.
 */
export function readChangedFiles({ childProcess, cwd, since }: ChangedFilesOptions): Array<string> {
	function git(directory: string, args: Array<string>): string {
		return childProcess.execFileSync("git", args, {
			cwd: directory,
			encoding: "utf-8",
			stdio: "pipe",
			windowsHide: true,
		});
	}

	const root = findGitRoot(() => git(cwd, ["rev-parse", "--show-toplevel"]));
	const commands = [
		...(since === UNCOMMITTED_REF
			? []
			: [["diff", "--name-only", "--no-renames", "-z", `${since}...HEAD`]]),
		["diff", "--cached", "--name-only", "--no-renames", "-z"],
		["ls-files", "-z", "--others", "--modified", "--exclude-standard"],
	];
	const files = commands.flatMap((args) => {
		try {
			return git(root, args).split("\0");
		} catch (err) {
			const failure = gitFailureSchema(err);
			const detail = failure instanceof type.errors ? String(err) : failure.stderr.trim();
			throw new Error(`Command \`git ${args.join(" ")}\` failed:\n${detail}`, { cause: err });
		}
	});
	const changed = files.filter((file) => file !== "");
	return [...new Set(changed.map((file) => normalizeWindowsPath(path.resolve(root, file))))];
}

function findGitRoot(readRoot: () => string): string {
	try {
		return readRoot().trim();
	} catch (err) {
		throw new Error("Could not find Git root. Have you initialized git with `git init`?", {
			cause: err,
		});
	}
}
