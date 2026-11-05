import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { FakeHelper, type FakeHelperSpawnCall } from "#test/mocks/spec-fake-helper.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { launchOnHiddenDesktop } from "./hidden-desktop.ts";

const PLACE_FILE = "C:/work/place.rbxl";

function makeLaunch(studioArgs: Array<string> = ["--task", "RunScript", "C:/my place/place.rbxl"]) {
	const { fileSystem } = createMemoryFileSystem();
	const helper = new FakeHelper();
	const calls: Array<FakeHelperSpawnCall> = [];
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
		spawn: (
			...[file, args, options]: [string, Array<string>, FakeHelperSpawnCall["options"]]
		) => {
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
	return { calls, errors, helper, killCommands, killProcess, studio };
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

	it("should report a helper that exits non-zero", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish({ code: 1, stderr: "CreateDesktopW failed\r\n" });

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: hidden desktop launch failed (exit 1): CreateDesktopW failed",
		]);
	});
});
