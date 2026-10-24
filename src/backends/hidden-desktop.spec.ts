import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { launchOnHiddenDesktop } from "./hidden-desktop.ts";

const PLACE_FILE = "C:/work/place.rbxl";

interface FakeExit {
	code: number;
	stderr?: string;
	stdout?: string;
}

interface SpawnCall {
	args: Array<string>;
	file: string;
	options: { env: Record<string, string>; stdio: Array<string>; windowsHide: boolean };
}

class FakeHelper extends EventEmitter {
	public readonly kill = vi.fn<() => boolean>(() => true);
	public readonly stderr = makeStream();
	public readonly stdout = makeStream();

	public exitCode: null | number = null;
	public signalCode: NodeJS.Signals | null = null;

	public finish({ code, stderr = "", stdout = "" }: FakeExit): void {
		this.stdout.emit("data", stdout);
		this.stderr.emit("data", stderr);
		this.emit("close", code);
	}
}

function makeStream() {
	const stream = Object.assign(new EventEmitter(), {
		encoding: undefined as string | undefined,
		setEncoding: (encoding: string) => {
			stream.encoding = encoding;
		},
	});
	return stream;
}

function makeLaunch(studioArgs: Array<string> = ["--task", "RunScript", "C:/my place/place.rbxl"]) {
	const { fileSystem, volume } = createMemoryFileSystem();
	volume.fromJSON({ [`${PLACE_FILE}.lock`]: "" });
	const helper = new FakeHelper();
	const calls: Array<SpawnCall> = [];
	const killProcess = vi.fn<(pid: number) => void>();
	const killCommands: Array<Array<string>> = [];
	const childProcess: ChildProcessRunner = fromAny({
		execFile: (
			...[file, args, options, callback]: [
				string,
				Array<string>,
				{ windowsHide: boolean },
				(error: Error | null) => void,
			]
		) => {
			killCommands.push([file, ...args, `windowsHide=${String(options.windowsHide)}`]);
			try {
				killProcess(Number(args[1]));
				callback(null);
			} catch (err) {
				callback(err instanceof Error ? err : new Error(String(err)));
			}
		},
		spawn: (...[file, args, options]: [string, Array<string>, SpawnCall["options"]]) => {
			calls.push({ args, file, options });
			return helper;
		},
	});
	const studio = launchOnHiddenDesktop({
		args: studioArgs,
		childProcess,
		fileSystem,
		placeFile: PLACE_FILE,
		studioPath: "C:/Program Files/Studio/RobloxStudioBeta.exe",
	});
	const errors: Array<Error> = [];
	studio.onError((error) => {
		errors.push(error);
	});
	return { calls, errors, fileSystem, helper, killCommands, killProcess, studio, volume };
}

function useFakeTimers(): void {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "Date"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

describe(launchOnHiddenDesktop, () => {
	it.for([
		["plain", "plain"],
		["", '""'],
		["C:/my place/a.rbxl", '"C:/my place/a.rbxl"'],
		['say "hi"', String.raw`"say \"hi\""`],
		[String.raw`C:\dir with space\\`, String.raw`"C:\dir with space\\\\"`],
		[String.raw`a\"b c`, String.raw`"a\\\"b c"`],
		[String.raw`C:\no\space`, String.raw`C:\no\space`],
	] as const)("should quote the Studio argument %j as %s", ([input, expected]) => {
		expect.assertions(1);

		const { calls } = makeLaunch([input]);

		expect(calls[0]!.options.env["JEST_ROBLOX_HIDDEN_DESKTOP_COMMAND_LINE"]).toBe(
			`"C:/Program Files/Studio/RobloxStudioBeta.exe" ${expected}`,
		);
	});

	it.for([
		["1234\r\n", 1234],
		["  42 \n", 42],
		["noise\r\n77\r\n", 77],
	] as const)("should take the PID from stdout %j", ([stdout, expected]) => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		helper.stdout.emit("data", stdout);
		studio.kill();

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(expected);
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

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(123);
	});

	it("should take the PID only once", () => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		studio.kill();
		helper.stdout.emit("data", "5\n");
		helper.finish({ code: 0, stdout: "6\n" });

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(5);
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

	it("should pass Studio to a hidden PowerShell helper through the environment", () => {
		expect.assertions(5);

		const { calls } = makeLaunch();
		const call = calls[0]!;

		expect(call.file).toBe("powershell.exe");
		expect(call.args.slice(0, 3)).toStrictEqual([
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		]);
		expect(call.options).toMatchObject({
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		expect(call.options.env).toMatchObject({
			JEST_ROBLOX_HIDDEN_DESKTOP: "jest-roblox-studio",
			JEST_ROBLOX_HIDDEN_DESKTOP_APPLICATION: "C:/Program Files/Studio/RobloxStudioBeta.exe",
			JEST_ROBLOX_HIDDEN_DESKTOP_COMMAND_LINE:
				'"C:/Program Files/Studio/RobloxStudioBeta.exe" --task RunScript "C:/my place/place.rbxl"',
		});
		expect(Buffer.from(call.args[3]!, "base64").toString("utf16le")).not.toContain(
			"Program Files",
		);
	});

	it("should hand Studio an environment without the helper variables", () => {
		expect.assertions(1);

		const { calls } = makeLaunch();

		expect(Buffer.from(calls[0]!.args[3]!, "base64").toString("utf16le")).toContain(
			"Remove-Item Env:JEST_ROBLOX_HIDDEN_DESKTOP, Env:JEST_ROBLOX_HIDDEN_DESKTOP_APPLICATION, Env:JEST_ROBLOX_HIDDEN_DESKTOP_COMMAND_LINE",
		);
	});

	it("should keep the helper alive until Studio exits", () => {
		expect.assertions(1);

		const { calls } = makeLaunch();

		expect(Buffer.from(calls[0]!.args[3]!, "base64").toString("utf16le")).toContain(
			"WaitForSingleObject(information.process, 0xFFFFFFFF);",
		);
	});

	it("should kill the printed PID", () => {
		expect.assertions(1);

		const { helper, killCommands, studio } = makeLaunch();
		helper.finish({ code: 0, stdout: "4321\r\n" });
		studio.kill();

		expect(killCommands).toStrictEqual([
			[
				"taskkill",
				"/PID",
				"4321",
				"/FI",
				"IMAGENAME eq RobloxStudioBeta.exe",
				"/F",
				"windowsHide=true",
			],
		]);
	});

	it("should defer a kill requested before the PID arrives", () => {
		expect.assertions(2);

		const { helper, killProcess, studio } = makeLaunch();
		studio.kill();

		expect(killProcess).not.toHaveBeenCalled();

		helper.finish({ code: 0, stdout: "77" });

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(77);
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

	it("should swallow a kill of a process that already exited", () => {
		expect.assertions(1);

		const { helper, killProcess, studio } = makeLaunch();
		killProcess.mockImplementation(() => {
			throw new Error("ESRCH");
		});
		helper.finish({ code: 0, stdout: "9" });

		expect(() => {
			studio.kill();
		}).not.toThrow();
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

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(5);
	});

	it("should kill at the grace cap while the lock is still held", () => {
		expect.assertions(1);

		useFakeTimers();
		const { fileSystem, helper, killProcess, studio } = makeLaunch();
		helper.finish({ code: 0, stdout: "5" });
		fileSystem.writeFileSync(`${PLACE_FILE}.lock`, "");
		studio.killOnLockRelease(1000);
		vi.advanceTimersByTime(1100);

		expect(killProcess).toHaveBeenCalledExactlyOnceWith(5);
	});

	it("should report a helper that exits non-zero", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish({ code: 1, stderr: "CreateDesktopW failed\r\n" });

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: hidden desktop launch failed (exit 1): CreateDesktopW failed",
		]);
	});

	it("should report a helper that prints no PID", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish({ code: 0, stdout: "garbage\r\n" });

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: hidden desktop helper printed no PID: garbage",
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
