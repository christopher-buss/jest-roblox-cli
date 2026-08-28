import * as cp from "node:child_process";

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
 */
export async function buildWithRojoAsync(projectPath: string, outputPath: string): Promise<void> {
	const failure = await runRojoAsync(projectPath, outputPath);
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
 */
async function runRojoAsync(
	projectPath: string,
	outputPath: string,
): Promise<RojoFailure | undefined> {
	return new Promise((resolve) => {
		cp.execFile(
			"rojo",
			["build", projectPath, "-o", outputPath],
			{ windowsHide: true },
			(cause: Error | null, _stdout: string, stderr: string) => {
				resolve(cause === null ? undefined : { cause, stderr });
			},
		);
	});
}
