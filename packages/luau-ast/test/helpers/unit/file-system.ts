import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";

import type { RequireFileSystem } from "#src/require-aliases.ts";

export interface MemoryFileSystem {
	fileSystem: RequireFileSystem;
	volume: ReturnType<typeof memfs>["vol"];
}

export function memoryFileSystem(files: Record<string, string>): MemoryFileSystem {
	const { fs, vol } = memfs(files, "/");
	return { fileSystem: fromAny(fs), volume: vol };
}
