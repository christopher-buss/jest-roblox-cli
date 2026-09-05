import * as nodeChildProcess from "node:child_process";

/**
 * The `node:child_process` surface this CLI reaches for, named once so every
 * module that launches a child takes it as a parameter rather than importing
 * the builtin itself.
 *
 * Same reason as `FileSystem` in `./file-system.ts`: `vi.mock` of a builtin
 * holds only while no earlier file in the same worker evaluated it unmocked,
 * which is a guarantee Vitest gives with process isolation and takes away
 * without it.
 */
export type ChildProcessRunner = Pick<
	typeof nodeChildProcess,
	"execFile" | "execFileSync" | "spawn"
>;

/** The real launcher, and the only one production ever uses. */
export const nodeChildProcessRunner: ChildProcessRunner = nodeChildProcess;
