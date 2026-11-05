import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { hasFormatter } from "../formatters/utils.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

/** Inputs of {@link withRunLogAsync}. */
export interface RunLogOptions {
	/** Root directory for the log path and formatters for the hint. */
	config: Pick<ResolvedConfig, "formatters" | "rootDir">;
	/** File system for the log; defaults to Node's. */
	fileSystem?: FileSystem;
	/** Streams to copy into the log. */
	streams: RunLogStreams;
}

/**
 * A standard stream as the log touches it: `write` is swapped out and back,
 * nothing else. The trailing arguments — an encoding, a callback — pass through
 * unnamed.
 */
interface RunLogStream {
	/** Write a chunk; the log swaps it out for the run and back after. */
	write: (chunk: string | Uint8Array, ...rest: Array<never>) => boolean;
}

/** The two streams the run log copies. */
interface RunLogStreams {
	/** Standard error; also receives the log-path hint. */
	stderr: RunLogStream;
	/** Standard output. */
	stdout: RunLogStream;
}

/**
 * Run `runAsync` with everything it writes to either stream copied to the run
 * log as it is written, so an agent that read a slice of the output can read
 * the rest without paying for the run again.
 *
 * Written through synchronously rather than buffered: a run killed mid-way
 * leaves the output it had produced, and nothing is lost to `process.exit`.
 * The hint goes to stderr after the log is closed, so the log holds exactly
 * what the terminal held. Only the agent formatter is told: a human watching
 * a terminal has the output in front of them.
 *
 * @template T
 * @param options - Config, file system and streams to copy.
 * @param options.config - Root directory and formatters.
 * @param options.fileSystem - File system for the log.
 * @param options.streams - Streams to copy into the log.
 * @param runAsync - The run whose output the log copies.
 * @returns The result of `runAsync`.
 */
export async function withRunLogAsync<T>(
	{ config, fileSystem = nodeFileSystem, streams }: RunLogOptions,
	runAsync: () => Promise<T>,
): Promise<T> {
	const logPath = runLogPath(config.rootDir);
	const descriptor = openLog(fileSystem, logPath);
	if (descriptor === undefined) {
		return runAsync();
	}

	const restore = [
		tee({ descriptor, fileSystem, stream: streams.stdout }),
		tee({ descriptor, fileSystem, stream: streams.stderr }),
	];
	try {
		return await runAsync();
	} finally {
		for (const undo of restore) {
			undo();
		}

		fileSystem.closeSync(descriptor);
		if (hasFormatter(config.formatters, "agent")) {
			streams.stderr.write(`jest-roblox: the full output of this run is at ${logPath}\n`);
		}
	}
}

/**
 * Path of the run log under a root directory.
 *
 * @param rootDirectory - Project root directory.
 * @returns `.jest-roblox/last-run.log` under the root.
 */
function runLogPath(rootDirectory: string): string {
	return path.join(rootDirectory, ".jest-roblox", "last-run.log");
}

/**
 * A log that cannot be opened costs the log, never the run.
 *
 * @param fileSystem - File system to open the log with.
 * @param logPath - Path of the log file.
 * @returns The open descriptor, or `undefined` when the log cannot be opened.
 */
function openLog(fileSystem: FileSystem, logPath: string): number | undefined {
	try {
		fileSystem.mkdirSync(path.dirname(logPath), { recursive: true });
		return fileSystem.openSync(logPath, "w");
	} catch {
		return undefined;
	}
}

function tee({
	descriptor,
	fileSystem,
	stream,
}: {
	descriptor: number;
	fileSystem: FileSystem;
	stream: RunLogStream;
}): () => void {
	const original = stream.write;
	const passThrough = original.bind(stream);
	stream.write = (chunk, ...rest): boolean => {
		// One overload for both shapes a stream write carries.
		fileSystem.writeSync(descriptor, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		return passThrough(chunk, ...rest);
	};

	return () => {
		stream.write = original;
	};
}
