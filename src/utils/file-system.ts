import * as nodeFs from "node:fs";

/**
 * The `node:fs` surface this CLI reaches for, named once so every module that
 * touches the disk takes it as a parameter rather than importing `node:fs`
 * itself.
 *
 * A builtin cannot be swapped per test file: `vi.mock` of one holds only while
 * no earlier file in the same worker evaluated it unmocked, which is a
 * guarantee Vitest gives with process isolation and takes away without it. An
 * injected seam has no such precondition, so a spec hands the code under test
 * its own in-memory volume and nothing crosses between files.
 *
 * The list is the union of what the CLI calls, not all of `node:fs`. Widen it
 * when a caller needs another primitive; `memfs` implements the whole sync API,
 * so a spec's volume keeps satisfying it.
 */
export type FileSystem = Pick<
	typeof nodeFs,
	| "appendFileSync"
	| "closeSync"
	| "copyFileSync"
	| "existsSync"
	| "mkdirSync"
	| "mkdtempSync"
	| "openSync"
	| "readdirSync"
	| "readFileSync"
	| "readSync"
	| "realpathSync"
	| "renameSync"
	| "rmdirSync"
	| "rmSync"
	| "statSync"
	| "unlinkSync"
	| "utimesSync"
	| "writeFileSync"
	| "writeSync"
> & {
	readonly promises: FileSystemPromises;
};

/**
 * The promise-API methods the CLI awaits, picked the same way the sync members
 * below are. Narrow for the same reason: what a spec has to supply is what the
 * CLI calls, not the whole namespace.
 */
type FileSystemPromises = Pick<
	typeof nodeFs.promises,
	"mkdir" | "readdir" | "readFile" | "realpath" | "stat" | "writeFile"
>;

/**
 * The real filesystem, and the only {@link FileSystem} production ever uses.
 */
export const nodeFileSystem: FileSystem = nodeFs;
