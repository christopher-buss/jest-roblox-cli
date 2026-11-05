import { fromAny } from "@total-typescript/shoehorn";

import type { ChildProcess } from "node:child_process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { FakeHelper } from "#test/mocks/spec-fake-helper.ts";
import { launchThroughHelper } from "./hidden-helper.ts";

const PLACE_FILE = "C:/work/place.rbxl";

function makeLaunch() {
	const { fileSystem, volume } = createMemoryFileSystem({ [`${PLACE_FILE}.lock`]: "" });
	const helper = new FakeHelper();
	const killProcess = vi.fn<(pid: number, helper: ChildProcess) => void>();
	const studio = launchThroughHelper({
		fileSystem,
		killStudio: killProcess,
		label: "test helper",
		placeFile: PLACE_FILE,
		spawnHelper: () => fromAny(helper),
	});
	const errors: Array<Error> = [];
	studio.onError((error) => {
		errors.push(error);
	});
	return { errors, fileSystem, helper, killProcess, studio, volume };
}

function useFakeTimers(): void {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "Date"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

describe(launchThroughHelper, () => {
	it.for([
		["1234\r\n", 1234],
		["  42 \n", 42],
		["noise\r\n77\r\n", 77],
	] as const)("should take the PID from stdout %j", ([stdout, expected]) => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		helper.stdout.emit("data", stdout);
		studio.kill();

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(expected, helper);
	});

	it.for(["0\n", "12 34\n", "-5\n", "Exception: boom\n"])(
		"should not take %j as a PID",
		(stdout) => {
			expect.assertions(1);

			const { helper, killProcess, studio } = makeLaunch();
			helper.stdout.emit("data", stdout);
			studio.kill();

			expect(killProcess).not.toHaveBeenCalled();
		},
	);

	it("should take the PID before the helper exits", () => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		helper.stdout.emit("data", "12");
		helper.stdout.emit("data", "3\r\n");
		studio.kill();

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(123, helper);
	});

	it("should take the PID only once", () => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		studio.kill();
		helper.stdout.emit("data", "5\n");
		helper.finish({ code: 0, stdout: "6\n" });

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(5, helper);
	});

	it("should read the helper output as UTF-8", () => {
		expect.assertions(2);

		const { helper } = makeLaunch();

		expect(helper.stdout.encoding).toBe("utf8");
		expect(helper.stderr.encoding).toBe("utf8");
	});

	it("should ignore a helper failure after the PID arrives", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.stdout.emit("data", "5\n");
		helper.emit("error", new Error("late"));
		helper.finish({ code: 1, stderr: "WaitForInputIdle failed" });

		expect(errors).toStrictEqual([]);
	});

	it("should clear the stale place lock before spawning the helper", () => {
		expect.assertions(1);

		const { fileSystem } = makeLaunch();

		expect(fileSystem.existsSync(`${PLACE_FILE}.lock`)).toBeFalse();
	});

	it("should defer a kill requested before the PID arrives", () => {
		expect.assertions(2);

		const { helper, killProcess, studio } = makeLaunch();
		studio.kill();

		expect(killProcess).not.toHaveBeenCalled();

		helper.finish({ code: 0, stdout: "77" });

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(77, helper);
	});

	it("should stop the helper when a kill comes before the PID", () => {
		expect.assertions(1);

		const { helper, studio } = makeLaunch();
		studio.kill();

		expect(helper.kill).toHaveBeenCalledOnce();
	});

	it("should stop a helper that outlives a kill by the exit cap", () => {
		expect.assertions(2);

		useFakeTimers();
		const { helper, studio } = makeLaunch();
		helper.stdout.emit("data", "5\r\n");
		studio.kill();
		vi.advanceTimersByTime(4999);

		expect(helper.kill).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);

		expect(helper.kill).toHaveBeenCalledOnce();
	});

	it("should leave a helper that exited within the exit cap", () => {
		expect.assertions(1);

		useFakeTimers();
		const { helper, studio } = makeLaunch();
		helper.stdout.emit("data", "5\r\n");
		studio.kill();
		helper.exitCode = 0;
		vi.advanceTimersByTime(5000);

		expect(helper.kill).not.toHaveBeenCalled();
	});

	it("should leave a signalled helper at the exit cap", () => {
		expect.assertions(1);

		useFakeTimers();
		const { helper, studio } = makeLaunch();
		helper.stdout.emit("data", "5\r\n");
		studio.kill();
		helper.signalCode = "SIGTERM";
		vi.advanceTimersByTime(5000);

		expect(helper.kill).not.toHaveBeenCalled();
	});

	it("should kill once the place lock is released", () => {
		expect.assertions(2);

		useFakeTimers();
		const { fileSystem, helper, killProcess, studio, volume } = makeLaunch();
		helper.finish({ code: 0, stdout: "5" });
		fileSystem.writeFileSync(`${PLACE_FILE}.lock`, "");
		studio.killOnLockRelease(10_000);
		vi.advanceTimersByTime(200);

		expect(killProcess).not.toHaveBeenCalled();

		volume.rmSync(`${PLACE_FILE}.lock`);
		vi.advanceTimersByTime(100);

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(5, helper);
	});

	it("should report a helper that exits non-zero under its label", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish({ code: 1, stderr: "CreateDesktopW failed\r\n" });

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: test helper launch failed (exit 1): CreateDesktopW failed",
		]);
	});

	it("should report a helper that prints no PID", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish({ code: 0, stdout: "garbage\r\n" });

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: test helper helper printed no PID: garbage",
		]);
	});

	it("should report a helper that fails to spawn", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		const failure = new Error("spawn powershell.exe ENOENT");
		helper.emit("error", failure);

		expect(errors).toStrictEqual([failure]);
	});
});
