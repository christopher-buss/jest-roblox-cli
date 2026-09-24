import path from "node:path";

import type { FileSystem } from "../src/utils/file-system.ts";

export interface SeaExecutableOptions {
	readonly cacheDirectory: string;
	readonly execPath: string;
	readonly fileSystem: FileSystem;
	readonly platform: NodeJS.Platform;
	readonly strip: (file: string) => void;
	readonly version: string;
}

/**
 * The node binary the standalone executable is built from: a stripped copy of
 * the running node on linux, and the running node itself elsewhere.
 *
 * The official linux node ships its symbol tables. The copy is stripped
 * before the blob is injected: stripping an executable that already holds one
 * breaks it.
 */
export function resolveSeaExecutable({
	cacheDirectory,
	execPath,
	fileSystem,
	platform,
	strip,
	version,
}: SeaExecutableOptions): string {
	if (platform !== "linux") {
		return execPath;
	}

	const executable = path.posix.join(cacheDirectory, `node-${version}-${platform}-stripped`);
	if (fileSystem.existsSync(executable)) {
		return executable;
	}

	const pending = `${executable}.pending`;
	fileSystem.mkdirSync(cacheDirectory, { recursive: true });
	fileSystem.copyFileSync(execPath, pending);
	strip(pending);
	fileSystem.renameSync(pending, executable);
	return executable;
}
