import * as nodeFs from "node:fs";

/**
 * The `node:fs` surface this library reads through, named once so a caller can
 * hand it a filesystem of its own.
 *
 * A consumer testing against an in-memory volume cannot reach a builtin this
 * library imported for itself: `vi.mock` of one holds only while no earlier
 * file in the same worker evaluated it unmocked, which is a guarantee Vitest
 * gives with process isolation and takes away without it. Every entry point
 * that reads a project file takes this instead, defaulting to the real thing.
 */
export type FileSystem = Pick<
	typeof nodeFs,
	"existsSync" | "readdirSync" | "readFileSync" | "realpathSync" | "statSync"
>;

/** The real filesystem, and the only one production ever uses. */
export const nodeFileSystem: FileSystem = nodeFs;
