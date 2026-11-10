import * as nodeChildProcess from "node:child_process";

/** The `node:child_process` surface the CLI uses, passed as a parameter. */
export type ChildProcessRunner = Pick<
	typeof nodeChildProcess,
	"execFile" | "execFileSync" | "spawn"
>;

/** The real launcher. */
export const nodeChildProcessRunner: ChildProcessRunner = nodeChildProcess;
