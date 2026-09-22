import { Buffer } from "node:buffer";
import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { hasFormatter } from "../formatters/utils.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

/**
 * A standard stream as the log touches it: `write` is swapped out and back,
 * nothing else. The trailing arguments — an encoding, a callback — pass through
 * unnamed.
 */
export interface RunLogStream {
	write: (chunk: string | Uint8Array, ...rest: Array<never>) => boolean;
}

export interface RunLogStreams {
	stderr: RunLogStream;
	stdout: RunLogStream;
}

export interface RunLogOptions {
	config: Pick<ResolvedConfig, "formatters" | "rootDir">;
	fileSystem?: FileSystem;
	streams: RunLogStreams;
}

export function runLogPath(rootDirectory: string): string {
	return path.join(rootDirectory, ".jest-roblox", "last-run.log");
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
		tee(streams.stdout, fileSystem, descriptor),
		tee(streams.stderr, fileSystem, descriptor),
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

/** A log that cannot be opened costs the log, never the run. */
function openLog(fileSystem: FileSystem, logPath: string): number | undefined {
	try {
		fileSystem.mkdirSync(path.dirname(logPath), { recursive: true });
		return fileSystem.openSync(logPath, "w");
	} catch {
		return undefined;
	}
}

function tee(stream: RunLogStream, fileSystem: FileSystem, descriptor: number): () => void {
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
