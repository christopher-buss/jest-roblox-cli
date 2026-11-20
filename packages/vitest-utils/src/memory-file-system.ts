import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";
import type * as nodeFileSystem from "node:fs";
import process from "node:process";

/** The memfs volume behind a memory file system. */
export type MemoryVolume = ReturnType<typeof memfs>["vol"];

/** An in-memory file system and the volume that holds its files. */
export interface MemoryFileSystem {
	/** The file system, typed as `node:fs` so any port over it accepts it. */
	readonly fileSystem: typeof nodeFileSystem;
	/** The volume, for direct reads and writes that bypass the port. */
	readonly volume: MemoryVolume;
}

/**
 * Creates a file system on a fresh in-memory volume.
 *
 * @param seed - Initial file contents, keyed by path.
 * @param cwd - The directory relative paths resolve against.
 * @returns The file system and its volume.
 */
export function createMemoryFileSystem(
	seed?: Record<string, string>,
	cwd: string = process.cwd(),
): MemoryFileSystem {
	const { fs, vol } = memfs(seed, cwd);
	// memfs types its API a Node release behind the builtin it mirrors.
	return { fileSystem: fromAny(fs), volume: vol };
}
