import { Buffer } from "node:buffer";
import * as path from "node:path";

import { usesAgentFormatter } from "../config/formatter-selection.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";

/**
 * Inputs of {@link withRunLogAsync}.
 * @template T
 */
export interface RunLogOptions<T> {
	/** The bootstrap target, used until the run resolves its own. */
	config: RunLogTarget;
	/** File system for the log; defaults to Node's. */
	fileSystem: FileSystem;
	/** The target the finished run resolved, if it resolved one. */
	runTarget: (value: T) => RunLogTarget | undefined;
	/** Streams to copy into the log. */
	streams: RunLogStreams;
}

type RunLogTarget = Pick<ResolvedConfig, "formatters" | "rootDir" | "verbose">;

interface RunLogStream {
	write: (chunk: string | Uint8Array, ...rest: Array<never>) => boolean;
}

interface RunLogStreams {
	stderr: RunLogStream;
	stdout: RunLogStream;
}

/**
 * Run `runAsync` with everything it writes to either stream copied to the
 * run log as it is written.
 * @template T
 * @param options - Bootstrap target, file system, run target and streams.
 * @param runAsync - The run whose output the log copies.
 * @returns The result of `runAsync`.
 */
export async function withRunLogAsync<T>(
	{ config, fileSystem, runTarget, streams }: RunLogOptions<T>,
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
	let target = config;
	try {
		const value = await runAsync();
		target = runTarget(value) ?? config;
		return value;
	} finally {
		for (const undo of restore) {
			undo();
		}

		fileSystem.closeSync(descriptor);
		const finalPath = moveLog(fileSystem, { from: logPath, to: runLogPath(target.rootDir) });
		if (usesAgentFormatter(target)) {
			streams.stderr.write(`jest-roblox: the full output of this run is at ${finalPath}\n`);
		}
	}
}

function moveLog(fileSystem: FileSystem, { from, to }: { from: string; to: string }): string {
	try {
		fileSystem.mkdirSync(path.dirname(to), { recursive: true });
		fileSystem.renameSync(from, to);
		return to;
	} catch {
		return from;
	}
}

function runLogPath(rootDirectory: string): string {
	return path.join(rootDirectory, WORK_DIRECTORY, "last-run.log");
}

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
		fileSystem.writeSync(descriptor, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		return passThrough(chunk, ...rest);
	};

	return () => {
		stream.write = original;
	};
}
