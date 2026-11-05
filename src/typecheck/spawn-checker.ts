import type { ChildProcess, ExecFileException } from "node:child_process";

import type { ChildProcessRunner } from "../utils/child-process.ts";

/** Milliseconds a checker may take to start before it is killed. */
export const DEFAULT_SPAWN_TIMEOUT = 10_000;

/**
 * Milliseconds a checker may run before it is killed and the pass throws.
 * Mirrors the run-level `timeout` default (`config.timeout`).
 */
export const DEFAULT_RUN_TIMEOUT = 300_000;

/** Inputs for one type-checker process. */
export interface SpawnCheckerOptions {
	/** Arguments passed to the command. */
	args: Array<string>;
	/** Spawns the process. */
	childProcess: ChildProcessRunner;
	/** The executable to run. */
	command: string;
	/** The process's working directory. */
	cwd: string;
	/** Names the checker in timeout errors. */
	label: string;
	/** Milliseconds the checker may run before it is killed. */
	runTimeout: number;
	/** Milliseconds the checker may take to start. */
	spawnTimeout: number;
}

interface SettleOptions {
	error: ExecFileException | null;
	finish: (action: () => void) => void;
	label: string;
	reject: (reason: Error) => void;
	resolve: (value: string) => void;
	runTimeout: number;
	stderr: string;
	stdout: string;
}

/**
 * Run a type checker and collect its output. A non-zero exit still resolves,
 * because type errors are the output.
 * @param options - The command, arguments, working directory and timeouts.
 * @returns The checker's stdout, or its stderr when stdout is empty.
 * @rejects When the checker fails to start, starts too slowly, or times out.
 */
export async function spawnCheckerAsync(options: SpawnCheckerOptions): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		executeChecker({ ...options, reject, resolve });
	});
}

function settleCheckerResult({
	error,
	finish,
	label,
	reject,
	resolve,
	runTimeout,
	stderr,
	stdout,
}: SettleOptions): void {
	if (error === null) {
		finish(() => {
			resolve(stdout);
		});
		return;
	}

	// Only the run deadline kills here; fail loud rather than read truncated
	// output as clean.
	if (error.killed === true) {
		const message = `${label} typecheck timed out after ${String(runTimeout)}ms (timeout)`;
		finish(() => {
			reject(new Error(message));
		});
		return;
	}

	if (typeof error.code === "number") {
		finish(() => {
			resolve(stdout !== "" ? stdout : stderr);
		});
		return;
	}

	finish(() => {
		reject(new Error(error.message, { cause: error }));
	});
}

function armLaunchTimer({
	child,
	finish,
	label,
	reject,
	spawnTimeout,
}: {
	child: ChildProcess;
	finish: (action: () => void) => void;
	label: string;
	reject: (reason: Error) => void;
	spawnTimeout: number;
}): ReturnType<typeof setTimeout> {
	const message = `${label} spawn timed out after ${String(spawnTimeout)}ms (spawnTimeout)`;
	return setTimeout(() => {
		child.kill();
		finish(() => {
			reject(new Error(message));
		});
	}, spawnTimeout);
}

function executeChecker({
	args,
	childProcess,
	command,
	cwd,
	label,
	reject,
	resolve,
	runTimeout,
	spawnTimeout,
}: SpawnCheckerOptions & {
	reject: (reason: Error) => void;
	resolve: (value: string) => void;
}): void {
	let launchTimer: ReturnType<typeof setTimeout> | undefined;
	// An object so `no-unnecessary-condition` cannot narrow it to literal false.
	const state = { settled: false };

	function finish(action: () => void): void {
		state.settled = true;
		clearTimeout(launchTimer);

		action();
	}

	const settle = { finish, label, reject, resolve, runTimeout };
	const child = childProcess.execFile(
		command,
		args,
		{ cwd, encoding: "utf-8", timeout: runTimeout, windowsHide: true },
		// eslint-disable-next-line better-max-params/better-max-params -- Node fixes the execFile callback signature.
		(error, stdout, stderr) => {
			settleCheckerResult({ ...settle, error, stderr, stdout });
		},
	);

	child.once("spawn", () => {
		clearTimeout(launchTimer);
	});

	if (!state.settled) {
		launchTimer = armLaunchTimer({ child, finish, label, reject, spawnTimeout });
	}
}
