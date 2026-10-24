import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type { FileSystem } from "../utils/file-system.ts";
import type { StudioCliProcess } from "./studio-cli.ts";
import { clearStaleLock, watchLockRelease } from "./studio-lock.ts";

const LINE_SPLIT_PATTERN = /\r?\n/u;
const PID_PATTERN = /^\d+$/u;
const HELPER_EXIT_CAP_MS = 5000;

export interface HiddenHelperLaunch {
	fileSystem: FileSystem;
	killStudio: (pid: number, helper: ChildProcess) => void;
	label: string;
	placeFile: string;
	spawnHelper: () => ChildProcess;
}

interface HelperOutput {
	hasPid: boolean;
	readonly onPid: (pid: number) => void;
	stderr: string;
	stdout: string;
}

export function launchThroughHelper(launch: HiddenHelperLaunch): StudioCliProcess {
	const { fileSystem, label } = launch;
	const lockFile = clearStaleLock(fileSystem, launch.placeFile);
	const errors = new EventEmitter<{ failure: [Error] }>();
	const helper = launch.spawnHelper();
	const { onPid, terminate } = deferredKill({
		killStudio: (pid) => {
			launch.killStudio(pid, helper);
		},
		stopHelper: () => {
			stopHelper(helper);
		},
	});
	watchHelper(helper, {
		fail: (error) => {
			errors.emit("failure", error);
		},
		label,
		onPid,
	});

	return {
		kill: terminate,
		killOnLockRelease: (graceCapMs) => {
			watchLockRelease({ fileSystem, graceCapMs, lockFile, terminate });
		},
		onError: (listener) => {
			errors.on("failure", listener);
		},
	};
}

function isRunning(helper: ChildProcess): boolean {
	return helper.exitCode === null && helper.signalCode === null;
}

function stopHelper(helper: ChildProcess): void {
	if (isRunning(helper)) {
		helper.kill();
	}
}

function deferredKill({
	killStudio,
	stopHelper: stop,
}: {
	killStudio: (pid: number) => void;
	stopHelper: () => void;
}): {
	onPid: (pid: number) => void;
	terminate: () => void;
} {
	let studioPid: number | undefined;
	let isKillRequested = false;

	function terminate(): void {
		isKillRequested = true;
		if (studioPid === undefined) {
			stop();
			return;
		}

		killStudio(studioPid);
		setTimeout(stop, HELPER_EXIT_CAP_MS).unref();
	}

	return {
		onPid: (pid) => {
			studioPid = pid;
			if (isKillRequested) {
				terminate();
			}
		},
		terminate,
	};
}

function helperFailure({
	code,
	label,
	stderr,
	stdout,
}: {
	code: null | number;
	label: string;
	stderr: string;
	stdout: string;
}): Error {
	if (code !== 0) {
		return new Error(
			`studio-cli: ${label} launch failed (exit ${String(code)}): ${stderr.trim()}`,
		);
	}

	return new Error(`studio-cli: ${label} helper printed no PID: ${stdout.trim()}`);
}

function parsePidLine(line: string): number | undefined {
	const trimmed = line.trim();
	if (!PID_PATTERN.test(trimmed)) {
		return undefined;
	}

	const pid = Number.parseInt(trimmed, 10);
	return pid > 0 ? pid : undefined;
}

function takePid(output: HelperOutput, lines: ReadonlyArray<string>): void {
	if (output.hasPid) {
		return;
	}

	const pid = lines.map(parsePidLine).find((candidate) => candidate !== undefined);
	if (pid !== undefined) {
		output.hasPid = true;
		output.onPid(pid);
	}
}

function watchHelper(
	helper: ChildProcess,
	{
		fail,
		label,
		onPid,
	}: { fail: (error: Error) => void; label: string; onPid: (pid: number) => void },
): void {
	const output: HelperOutput = { hasPid: false, onPid, stderr: "", stdout: "" };
	helper.stdout?.setEncoding("utf8");
	helper.stderr?.setEncoding("utf8");
	helper.stdout?.on("data", (chunk: string) => {
		output.stdout += chunk;
		takePid(output, output.stdout.split(LINE_SPLIT_PATTERN).slice(0, -1));
	});
	helper.stderr?.on("data", (chunk: string) => {
		output.stderr += chunk;
	});
	helper.on("error", (error) => {
		if (!output.hasPid) {
			fail(error);
		}
	});
	helper.on("close", (code) => {
		takePid(output, output.stdout.split(LINE_SPLIT_PATTERN));
		if (!output.hasPid) {
			fail(helperFailure({ code, label, stderr: output.stderr, stdout: output.stdout }));
		}
	});
}
