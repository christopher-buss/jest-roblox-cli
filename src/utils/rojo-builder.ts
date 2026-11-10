import type { ChildProcessRunner } from "./child-process.ts";

/** Inputs for one `rojo build`. */
export interface RojoBuildOptions {
	/** Spawns rojo. Defaults to the real launcher. */
	readonly childProcess: ChildProcessRunner;
	/** Where the built place file goes. */
	readonly outputPath: string;
	/** The Rojo project file to build. */
	readonly projectPath: string;
}

interface RojoFailure {
	cause: Error;
	stderr: string;
}

/**
 * Run `rojo build` without blocking the event loop.
 * @param options - The project, output path and launcher.
 * @param options.childProcess - Spawns rojo.
 * @param options.outputPath - Where the built place file goes.
 * @param options.projectPath - The Rojo project file to build.
 * @rejects When rojo is not on PATH or the build fails.
 */
export async function buildWithRojoAsync({
	childProcess,
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
