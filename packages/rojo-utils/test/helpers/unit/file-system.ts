import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import { createFsFromVolume, type IFs, Volume } from "memfs";
import path from "node:path";

import type { FileSystem } from "../../../src/file-system.ts";

interface MemoryFixture {
	directory: string;
	fileSystem: FileSystem;
	fs: IFs;
}

export function makeFileSystem(files: Record<string, string> = {}): MemoryFixture {
	const fs = createFsFromVolume(new Volume());
	const directory = path.resolve("virtual-rojo");
	fs.mkdirSync(directory, { recursive: true });
	for (const [relativePath, content] of Object.entries(files)) {
		const fullPath = path.join(directory, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content);
	}

	function realpath(target: string): string {
		return path.resolve(String(fs.realpathSync(target)));
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
