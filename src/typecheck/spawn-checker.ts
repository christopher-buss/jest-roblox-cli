import type { ChildProcess, ExecFileException } from "node:child_process";

import type { ChildProcessRunner } from "../utils/child-process.ts";

/**
 * Milliseconds to wait for a checker to launch (the child `spawn` event) before
 * the pass fails. Bounds only process startup, so a slow check never trips it.
 */
export const DEFAULT_SPAWN_TIMEOUT = 10_000;

/**
 * Milliseconds a checker may run before it is killed and the pass throws.
 * Mirrors the run-level `timeout` default (`config.timeout`).
 */
export const DEFAULT_RUN_TIMEOUT = 300_000;

export interface SpawnCheckerOptions {
	args: Array<string>;
	childProcess: ChildProcessRunner;
	command: string;
	cwd: string;
	label: string;
	runTimeout: number;
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

	// `execFile`'s `timeout` (the run-level deadline) is the only kill it
	// causes, so `killed` is timeout-specific here: maxBuffer overflow surfaces
	// as a distinct `code` (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) with `killed`
	// unset. (The launch-timer kill settles the promise first, so its later
	// `killed` callback is a no-op.) Fail loud rather than let truncated/empty
	// output read as zero type errors.
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
