import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";
import process from "node:process";

import type { FileSystem } from "#src/utils/file-system.ts";

export type MemoryVolume = ReturnType<typeof memfs>["vol"];

export interface MemoryFileSystem {
	readonly fileSystem: FileSystem;
	readonly volume: MemoryVolume;
}

// `cwd` defaults to `process.cwd()`: memfs resolves relative reads against it.
/**
 * On Windows memfs strips the drive from `C:/foo`, hiding a mismatch.
 * @param seed - Initial file contents, keyed by path.
 * @param cwd - Base for relative paths.
 * @returns A file system on an in-memory volume.
 */
export function createMemoryFileSystem(
	seed?: Record<string, string>,
	cwd: string = process.cwd(),
): MemoryFileSystem {
	const { fs, vol } = memfs(seed, cwd);
	// memfs types lag a Node release (`promises.mkdir`, `mkdtempDisposable`);
	// bridge here rather than weaken `FileSystem`.
	return { fileSystem: fromAny(fs), volume: vol };
}
