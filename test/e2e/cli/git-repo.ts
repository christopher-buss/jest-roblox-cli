import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import nodeProcess from "node:process";

export interface GitRepo {
	/** Stage every file and commit it. */
	commit: (message: string) => void;
	/** Run git in the repository. */
	git: (...args: Array<string>) => void;
	/** Delete a file of the working tree. */
	remove: (relativePath: string) => void;
	/** Write a file of the working tree. */
	write: (relativePath: string, source: string) => void;
}

const GIT_IDENTITY = ["-c", "user.name=jest-roblox", "-c", "user.email=jest-roblox@example.com"];

/**
 * Make `root` a git repository on branch `main` that reads no host git config
 * and no `GIT_*` variable, so no host hook, signing rule or template reaches
 * it, and a git hook running the tests cannot point it at the outer repo.
 *
 * @param root - Folder to initialize.
 * @returns Commands that change the repository.
 */
export function initGitRepo(root: string): GitRepo {
	const environment = isolatedGitEnvironment(root);
	function git(...args: Array<string>): void {
		execFileSync("git", [...GIT_IDENTITY, ...args], {
			cwd: root,
			env: environment,
			stdio: "pipe",
			windowsHide: true,
		});
	}

	git("init", "--quiet", "--initial-branch=main");
	return {
		commit: (message) => {
			git("add", "--all");
			git("commit", "--quiet", "--message", message);
		},
		git,
		remove: (relativePath) => {
			fs.rmSync(path.join(root, relativePath));
		},
		write: (relativePath, source) => {
			fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
			fs.writeFileSync(path.join(root, relativePath), source);
		},
	};
}

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(nodeProcess.env).filter(([name]) => !name.startsWith("GIT_")),
		),
		GIT_CONFIG_GLOBAL: path.join(root, ".git", "no-global-config"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
}
