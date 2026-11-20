import { createMemoryFileSystem, type MemoryFileSystem } from "@isentinel/dev-vitest-utils";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";

import type { FileSystem } from "#src/file-system.ts";

interface MemoryFixture {
	directory: string;
	fileSystem: FileSystem;
	fs: MemoryFileSystem["fileSystem"];
}

export function makeFileSystem(files: Record<string, string> = {}): MemoryFixture {
	const directory = path.resolve("virtual-rojo");
	const { fileSystem: fs } = createMemoryFileSystem(files, directory);
	fs.mkdirSync(directory, { recursive: true });

	function realpath(target: string): string {
		return path.resolve(fs.realpathSync(target));
	}

	return {
		directory,
		fileSystem: fromPartial<FileSystem>({
			existsSync: fs.existsSync,
			readdirSync: fs.readdirSync,
			readFileSync: fs.readFileSync,
			realpathSync: Object.assign(realpath, { native: realpath }),
			statSync: fromAny<FileSystem["statSync"], typeof fs.statSync>(fs.statSync.bind(fs)),
		}),
		fs,
	};
}
