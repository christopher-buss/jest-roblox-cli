import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { spawnCheckerAsync } from "./spawn-checker.ts";

const CHECK_COMMAND = ["lute", "check"] as const;

const MISSING_CHECKER_MESSAGE = `Luau Type Tests need \`${CHECK_COMMAND[0]}\` on PATH, and it was not found.`;

const MISSING_CHECKER_HINT =
	"Install lute (https://github.com/luau-lang/lute), e.g. `mise use github:luau-lang/lute`.";

export interface LuauCheckOptions {
	childProcess: ChildProcessRunner;
	files: Array<string>;
	rootDir: string;
	runTimeout: number;
	spawnTimeout: number;
}

export async function spawnLuauCheckAsync(options: LuauCheckOptions): Promise<string> {
	const [command, subcommand] = CHECK_COMMAND;
	const files = options.files.map((file) => path.resolve(file));

	try {
		return await spawnCheckerAsync({
			args: [subcommand, ...files],
			childProcess: options.childProcess,
			command,
			cwd: options.rootDir,
			label: command,
			runTimeout: options.runTimeout,
			spawnTimeout: options.spawnTimeout,
		});
	} catch (err) {
		if (isMissingCommand(err)) {
			throw new ConfigError(MISSING_CHECKER_MESSAGE, MISSING_CHECKER_HINT);
		}

		throw err;
	}
}

function isMissingCommand(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.cause instanceof Error &&
		"code" in err.cause &&
		err.cause.code === "ENOENT"
	);
}
