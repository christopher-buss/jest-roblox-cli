import { fromAny } from "@total-typescript/shoehorn";

import * as childProcess from "node:child_process";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import { spawnCheckerAsync, type SpawnCheckerOptions } from "./spawn-checker.ts";

type Callback = (
	error: childProcess.ExecFileException | null,
	stdout: string,
	stderr: string,
) => void;

function nodeChecker(
	script: string,
	overrides: Partial<SpawnCheckerOptions> = {},
): SpawnCheckerOptions {
	return {
		args: ["-e", script],
		childProcess,
		command: process.execPath,
		cwd: process.cwd(),
		label: "node",
		runTimeout: 30_000,
		spawnTimeout: 30_000,
		...overrides,
	};
}

function stubChecker(respond?: (callback: Callback) => void) {
	const kill = vi.fn<() => void>();
	let spawnListener: (() => void) | undefined;
	const child: childProcess.ChildProcess = fromAny({
		kill,
		once: (_event: string, listener: () => void) => {
			spawnListener = listener;
		},
	});
	const runner: ChildProcessRunner = fromAny({
		execFile: (...execFileArguments: [string, Array<string>, object, Callback]) => {
			respond?.(execFileArguments[3]);
			return child;
		},
	});
	return { emitSpawn: () => spawnListener?.(), kill, runner };
}

describe(spawnCheckerAsync, () => {
	it("should resolve the stdout of a clean run", async () => {
		expect.assertions(1);

		await expect(spawnCheckerAsync(nodeChecker("process.stdout.write('clean')"))).resolves.toBe(
			"clean",
		);
	});

	it("should resolve the stdout of a run that exits with diagnostics", async () => {
		expect.assertions(1);

		await expect(
			spawnCheckerAsync(nodeChecker("process.stdout.write('found'); process.exit(2)")),
		).resolves.toBe("found");
	});

	it("should fall back to stderr when a failing run prints no stdout", async () => {
		expect.assertions(1);

		await expect(
			spawnCheckerAsync(nodeChecker("process.stderr.write('broken'); process.exit(1)")),
		).resolves.toBe("broken");
	});

	it("should reject a run killed at the run deadline", async () => {
		expect.assertions(1);

		const { runner } = stubChecker((callback) => {
			callback(Object.assign(new Error("killed"), { killed: true }), "partial", "");
		});

		await expect(
			spawnCheckerAsync(
				nodeChecker("", { childProcess: runner, label: "tsgo", runTimeout: 50 }),
			),
		).rejects.toThrow("tsgo typecheck timed out after 50ms (timeout)");
	});

	it("should reject a checker that cannot be spawned", async () => {
		expect.assertions(1);

		await expect(
			spawnCheckerAsync(nodeChecker("", { command: "jest-roblox-missing-checker" })),
		).rejects.toThrow(/ENOENT/);
	});

	it("should kill and reject a checker that never launches", async () => {
		expect.assertions(2);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const { kill, runner } = stubChecker();
		const result = spawnCheckerAsync(
			nodeChecker("", { childProcess: runner, label: "luau", spawnTimeout: 100 }),
		);
		vi.advanceTimersByTime(100);

		await expect(result).rejects.toThrow("luau spawn timed out after 100ms (spawnTimeout)");
		expect(kill).toHaveBeenCalledOnce();
	});

	it("should disarm the launch timer once the checker spawns", async () => {
		expect.assertions(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		let finish: Callback | undefined;
		const { emitSpawn, kill, runner } = stubChecker((callback) => {
			finish = callback;
		});
		const result = spawnCheckerAsync(
			nodeChecker("", { childProcess: runner, spawnTimeout: 100 }),
		);
		emitSpawn();
		vi.advanceTimersByTime(1000);
		finish!(null, "ok", "");
		await result;

		expect(kill).not.toHaveBeenCalled();
	});
});
