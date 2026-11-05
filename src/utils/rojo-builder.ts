import type { ChildProcessRunner } from "./child-process.ts";
import { nodeChildProcessRunner } from "./child-process.ts";

/** Inputs for one `rojo build`. */
export interface RojoBuildOptions {
	/** Spawns rojo. Defaults to the real launcher. */
	readonly childProcess?: ChildProcessRunner;
	/** Where the built place file goes. */
	readonly outputPath: string;
	/** The Rojo project file to build. */
	readonly projectPath: string;
}

/** A child that exited non-zero, paired with what it wrote to stderr. */
interface RojoFailure {
	cause: Error;
	stderr: string;
}

/**
 * Run `rojo build`, awaiting the child rather than blocking on it.
 *
 * Asynchronous because a build is seconds long, and a synchronous wait holds
 * the event loop for every one of them — the stage block above it repaints from
 * a timer, so a blocking build reports itself as taking no time at all until
 * the moment it ends.
 * @param options - The project, output path and launcher.
 * @param options.childProcess - Spawns rojo.
 * @param options.outputPath - Where the built place file goes.
 * @param options.projectPath - The Rojo project file to build.
 * @rejects When rojo is not on PATH or the build fails.
 */
export async function buildWithRojoAsync({
	childProcess = nodeChildProcessRunner,
	outputPath,
	projectPath,
}: RojoBuildOptions): Promise<void> {
	const failure = await runRojoAsync({ childProcess, outputPath, projectPath });
	if (failure === undefined) {
		return;
	}

	const { cause, stderr } = failure;
	if ("code" in cause && cause.code === "ENOENT") {
		throw new Error("rojo was not found on PATH");
	}

	const reported = stderr.trim();
	const message = reported === "" ? "rojo build failed" : `rojo build failed: ${reported}`;
	throw new Error(message, { cause });
}

/**
 * The child, as what went wrong or nothing at all.
 *
 * Reported rather than thrown because stderr does not ride on the error: the
 * callback takes it as its own argument, and only the synchronous form this
 * replaced hung it off the error object. Rejecting would drop it, and every
 * failed build would then report the same bare line with rojo's own diagnosis
 * of the project thrown away.
 * @param options - The project, output path and launcher.
 * @param options.childProcess - Spawns rojo.
 * @param options.outputPath - Where the built place file goes.
 * @param options.projectPath - The Rojo project file to build.
 * @returns The failure and its stderr, or `undefined` on success.
 */
async function runRojoAsync({
	childProcess,
	outputPath,
	projectPath,
}: Required<RojoBuildOptions>): Promise<RojoFailure | undefined> {
	return new Promise((resolve) => {
		childProcess.execFile(
			"rojo",
			["build", projectPath, "-o", outputPath],
			{ windowsHide: true },
			(...[cause, , stderr]: [Error | null, string, string]) => {
				resolve(cause === null ? undefined : { cause, stderr });
			},
		);
	});
}
