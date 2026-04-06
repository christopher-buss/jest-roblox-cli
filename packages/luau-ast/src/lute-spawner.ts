import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;

export interface LuteSpawnOptions {
	/** Arguments to pass after -- separator. */
	args: Array<string>;
	/** Max buffer size in bytes (default: 1MB). */
	maxBuffer?: number;
	/** Path to the Luau script to run. */
	scriptPath: string;
	/** Timeout in ms (default: 30_000). */
	timeout?: number;
}

/**
 * Spawn lute to run a Luau script and return its stdout.
 *
 * @param options - Spawn configuration.
 * @returns The stdout output from lute.
 */
export function spawnLute(options: LuteSpawnOptions): string {
	const { args, maxBuffer = DEFAULT_MAX_BUFFER, scriptPath, timeout = DEFAULT_TIMEOUT } = options;

	try {
		return cp.execFileSync("lute", ["run", scriptPath, "--", ...args], {
			encoding: "utf-8",
			maxBuffer,
			timeout,
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error(
				"lute is required but was not found on PATH. " +
					"Install it from https://github.com/luau-lang/lute",
			);
		}

		throw err;
	}
}

/**
 * Write a Luau script string to a temp file and return its path.
 *
 * @param source - Luau source code to write.
 * @param name - Base name for the temp file (without extension).
 * @returns Absolute path to the written .luau file.
 */
export function writeTemporaryLuauScript(source: string, name: string): string {
	const directory = path.join(os.tmpdir(), "luau-ast");
	fs.mkdirSync(directory, { recursive: true });

	const scriptPath = path.join(directory, `${name}.luau`);
	fs.writeFileSync(scriptPath, source);

	return scriptPath;
}
