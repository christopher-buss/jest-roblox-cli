import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { spawnCheckerAsync } from "./spawn-checker.ts";

const CHECK_COMMAND = ["lute", "check"] as const;

const MISSING_CHECKER_MESSAGE = `Luau Type Tests need \`${CHECK_COMMAND[0]}\` on PATH, and it was not found.`;

const MISSING_CHECKER_HINT =
	"Install lute (https://github.com/luau-lang/lute), e.g. `mise use github:luau-lang/lute`.";

/** Inputs for one `lute check` run. */
export interface LuauCheckOptions {
	/** Spawns the checker. */
	childProcess: ChildProcessRunner;
	/** The Luau files to check, resolved to absolute paths. */
	files: Array<string>;
	/** The checker's working directory. */
	rootDir: string;
	/** Milliseconds the checker may run before it is killed. */
	runTimeout: number;
	/** Milliseconds the checker may take to start. */
	spawnTimeout: number;
}

/**
 * Run `lute check` over the given files.
 * @param options - The files, working directory, timeouts and spawner.
 * @returns The checker's output.
 * @rejects {ConfigError} When `lute` is not on PATH.
 * @rejects When the checker fails to start or times out.
 */
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
