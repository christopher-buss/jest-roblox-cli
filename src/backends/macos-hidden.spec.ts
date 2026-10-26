import { fromAny } from "@total-typescript/shoehorn";

import { EventEmitter } from "node:events";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { findAppBundle, launchHiddenOnMacos } from "./macos-hidden.ts";

const PLACE_FILE = "/work/place.rbxl";
const BUNDLE = "/Applications/RobloxStudio.app";

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

	public finish(code: number, stderr = ""): void {
		this.exitCode = code;
		this.stderr.emit("data", stderr);
		this.emit("close", code);
	}
}

function makeStream() {
	return Object.assign(new EventEmitter(), { setEncoding: () => {} });
}

function makeLaunch(psOutput = "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta\n") {
	const { fileSystem } = createMemoryFileSystem();
	const helper = new FakeHelper();
	const calls: Array<SpawnCall> = [];
	const killCommands: Array<Array<string>> = [];
	const childProcess: ChildProcessRunner = fromAny({
		execFile: (
			...[file, args, options, callback]: [
				string,
				Array<string>,
				{ windowsHide: boolean },
				(error: Error | null, stdout: string) => void,
			]
		) => {
			killCommands.push([file, ...args, `windowsHide=${String(options.windowsHide)}`]);
			callback(null, file === "ps" ? psOutput : "");
		},
		spawn: (...[file, args, options]: [string, Array<string>, SpawnCall["options"]]) => {
			calls.push({ args, file, options });
			return helper;
		},
	});
	const studio = launchHiddenOnMacos(
		{
			args: ["-task", "RunScript", "/my place/place.rbxl"],
			childProcess,
			fileSystem,
			placeFile: PLACE_FILE,
			studioPath: `${BUNDLE}/Contents/MacOS/RobloxStudioBeta`,
		},
		BUNDLE,
	);
	const errors: Array<Error> = [];
	studio.onError((error) => {
		errors.push(error);
	});
	return { calls, errors, helper, killCommands, studio };
}

describe(findAppBundle, () => {
	it.for([
		[`${BUNDLE}/Contents/MacOS/RobloxStudioBeta`, BUNDLE],
		[
			"/Users/me/My Apps/Studio.app/Contents/MacOS/RobloxStudioBeta",
			"/Users/me/My Apps/Studio.app",
		],
		["/opt/studio/RobloxStudioBeta", undefined],
		[`${BUNDLE}/Contents/Resources/RobloxStudioBeta`, undefined],
	] as const)("should find the bundle of %s", ([studioPath, expected]) => {
		expect.assertions(1);

		expect(findAppBundle(studioPath)).toBe(expected);
	});
});

describe(launchHiddenOnMacos, () => {
	it("should pass the bundle and argv to a JXA helper through the environment", () => {
		expect.assertions(4);

		const { calls } = makeLaunch();
		const call = calls[0]!;

		expect(call.file).toBe("osascript");
		expect(call.args.slice(0, 3)).toStrictEqual(["-l", "JavaScript", "-e"]);
		expect(call.options).toMatchObject({
			env: {
				JEST_ROBLOX_MACOS_ARGS: '["-task","RunScript","/my place/place.rbxl"]',
				JEST_ROBLOX_MACOS_BUNDLE: BUNDLE,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		expect(call.args[3]).not.toContain("RobloxStudio");
	});

	it("should launch without activation, as a new instance, off the recent list, and keep Studio hidden", () => {
		expect.assertions(4);

		const script = makeLaunch().calls[0]!.args[3]!;

		expect(script).toContain("0x200 | 0x80000 | 0x100,");
		expect(script).not.toContain("$.NSWorkspaceLaunchWith");
		expect(script).toContain("!app.isHidden && !app.isActive");
		expect(script).toContain("while (!app.isTerminated)");
	});

	it("should hand Studio an environment without the helper variables", () => {
		expect.assertions(3);

		const script = makeLaunch().calls[0]!.args[3]!;

		expect(script).toContain('studioEnvironment.removeObjectForKey("JEST_ROBLOX_MACOS_ARGS");');
		expect(script).toContain(
			'studioEnvironment.removeObjectForKey("JEST_ROBLOX_MACOS_BUNDLE");',
		);
		expect(script).toContain(
			"configuration.setObjectForKey(studioEnvironment, $.NSWorkspaceLaunchConfigurationEnvironment);",
		);
	});

	it("should hand osascript a script that parses as JavaScript", () => {
		expect.assertions(1);

		const script = makeLaunch().calls[0]!.args[3]!;

		expect(() => new Script(script)).not.toThrow();
	});

	it("should SIGKILL the printed PID once ps names Studio, then stop the helper", () => {
		expect.assertions(2);

		const { helper, killCommands, studio } = makeLaunch();
		helper.stdout.emit("data", "4321\n");
		studio.kill();

		expect(killCommands).toStrictEqual([
			["ps", "-o", "comm=", "-p", "4321", "windowsHide=true"],
			["kill", "-KILL", "4321", "windowsHide=true"],
		]);
		expect(helper.kill).toHaveBeenCalledOnce();
	});

	it("should SIGKILL a Studio PID after the helper died", () => {
		expect.assertions(1);

		const { helper, killCommands, studio } = makeLaunch();
		helper.stdout.emit("data", "4321\n");
		helper.signalCode = "SIGINT";
		studio.kill();

		expect(killCommands.map(([file]) => file)).toStrictEqual(["ps", "kill"]);
	});

	it("should not kill a PID that ps names as another program", () => {
		expect.assertions(2);

		const { helper, killCommands, studio } = makeLaunch("/usr/bin/vim\n");
		helper.stdout.emit("data", "4321\n");
		studio.kill();

		expect(killCommands.map(([file]) => file)).toStrictEqual(["ps"]);
		expect(helper.kill).toHaveBeenCalledOnce();
	});

	it("should not kill a PID that no longer exists", () => {
		expect.assertions(1);

		const { helper, killCommands, studio } = makeLaunch("");
		helper.stdout.emit("data", "4321\n");
		studio.kill();

		expect(killCommands.map(([file]) => file)).toStrictEqual(["ps"]);
	});

	it("should kill Studio when its PID arrives after a kill stopped the helper", () => {
		expect.assertions(2);

		const { helper, killCommands, studio } = makeLaunch();
		studio.kill();

		expect(helper.kill).toHaveBeenCalledOnce();

		helper.stdout.emit("data", "4321\n");

		expect(killCommands.map(([file]) => file)).toStrictEqual(["ps", "kill"]);
	});

	it("should report a launch the helper could not make", () => {
		expect.assertions(1);

		const { errors, helper } = makeLaunch();
		helper.finish(1, "execution error: Error: The application cannot be opened. (-1)\n");

		expect(errors.map((error) => error.message)).toStrictEqual([
			"studio-cli: macOS hidden launch failed (exit 1): execution error: Error: The application cannot be opened. (-1)",
		]);
	});
});
