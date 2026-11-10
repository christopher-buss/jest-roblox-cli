import type { FileSystem as RojoFileSystem } from "@isentinel/rojo-utils";

import * as nodeFs from "node:fs";

export type { Dirent, Stats } from "node:fs";

/** The `node:fs` surface the CLI uses, passed as a parameter. */
export type FileSystem = Pick<
	typeof nodeFs,
	| "appendFileSync"
	| "closeSync"
	| "copyFileSync"
	| "mkdirSync"
	| "mkdtempSync"
	| "openSync"
	| "readSync"
	| "renameSync"
	| "rmdirSync"
	| "rmSync"
	| "unlinkSync"
	| "utimesSync"
	| "writeFileSync"
	| "writeSync"
> &
	RojoFileSystem & {
		readonly promises: FileSystemPromises;
	};

type FileSystemPromises = Pick<
	typeof nodeFs.promises,
	"mkdir" | "readdir" | "readFile" | "realpath" | "stat" | "writeFile"
>;

/** The real filesystem. */
export const nodeFileSystem: FileSystem = nodeFs;
