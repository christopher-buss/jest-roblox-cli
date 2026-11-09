import type { ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { readChangedFiles } from "./changed-files.ts";

const ROOT = path.resolve("/repo");

type GitReply = Error | string;

interface FakeGit {
	execFileSync: (
		...call: [
			file: string,
			args: ReadonlyArray<string>,
			options: ExecFileSyncOptionsWithStringEncoding,
		]
	) => string;
	hidden: Array<boolean | undefined>;
}

function posixPath(...segments: Array<string>): string {
	return path.join(...segments).replaceAll("\\", "/");
}

function fakeGit(replies: Record<string, GitReply>): FakeGit {
	const hidden: Array<boolean | undefined> = [];
	return {
		execFileSync: (...call) => {
			const [file, args, options] = call;
			hidden.push(options.windowsHide);
			const reply = replies[[file, ...args].join(" ")] ?? "";
			if (reply instanceof Error) {
				throw reply;
			}

			return reply;
		},
		hidden,
	};
}

function gitFailure(stderr: string): Error {
	return Object.assign(new Error("Command failed"), { stderr });
}

describe(readChangedFiles, () => {
	it("should read the uncommitted files only when the ref is HEAD", () => {
		expect.assertions(2);

		const git = fakeGit({
			"git diff --cached --name-only --no-renames -z": "src/a.luau\0src/b.luau\0",
			"git diff --name-only --no-renames -z HEAD...HEAD": "src/committed.luau\0",
			"git ls-files -z --others --modified --exclude-standard": "src/b.luau\0src/c.luau\0",
			"git rev-parse --show-toplevel": `${ROOT}\n`,
		});

		expect(readChangedFiles({ childProcess: git, cwd: ROOT, since: "HEAD" })).toStrictEqual(
			["src/a.luau", "src/b.luau", "src/c.luau"].map((file) => posixPath(ROOT, file)),
		);
		expect(git.hidden).toStrictEqual([true, true, true]);
	});

	it("should add the files committed since the merge base of another ref", () => {
		expect.assertions(1);

		const git = fakeGit({
			"git diff --name-only --no-renames -z main...HEAD": "committed.luau\0",
			"git rev-parse --show-toplevel": `${ROOT}\n`,
		});

		expect(readChangedFiles({ childProcess: git, cwd: ROOT, since: "main" })).toStrictEqual([
			posixPath(ROOT, "committed.luau"),
		]);
	});

	it("should name the failed git command with its stderr", () => {
		expect.assertions(1);

		const failure = gitFailure("fatal: bad index\n");
		const git = fakeGit({
			"git diff --cached --name-only --no-renames -z": failure,
			"git rev-parse --show-toplevel": `${ROOT}\n`,
		});

		expect(() => readChangedFiles({ childProcess: git, cwd: ROOT, since: "HEAD" })).toThrow(
			expect.objectContaining({
				cause: failure,
				message:
					"Command `git diff --cached --name-only --no-renames -z` failed:\nfatal: bad index",
			}),
		);
	});

	it("should name the failed git command with its error when it wrote no stderr", () => {
		expect.assertions(1);

		const git = fakeGit({
			"git diff --cached --name-only --no-renames -z": new Error("spawn git ENOENT"),
			"git rev-parse --show-toplevel": `${ROOT}\n`,
		});

		expect(() => readChangedFiles({ childProcess: git, cwd: ROOT, since: "HEAD" })).toThrow(
			"Command `git diff --cached --name-only --no-renames -z` failed:\nError: spawn git ENOENT",
		);
	});

	it("should say when the folder is in no git repository", () => {
		expect.assertions(1);

		const failure = gitFailure("fatal: not a git repository");
		const git = fakeGit({ "git rev-parse --show-toplevel": failure });

		expect(() => readChangedFiles({ childProcess: git, cwd: ROOT, since: "HEAD" })).toThrow(
			expect.objectContaining({
				cause: failure,
				message: "Could not find Git root. Have you initialized git with `git init`?",
			}),
		);
	});
});
