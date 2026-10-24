import type { ChildProcess } from "node:child_process";
import process from "node:process";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { launchThroughHelper } from "./hidden-helper.ts";
import type { StudioCliProcess } from "./studio-cli.ts";

const BUNDLE_ENV = "JEST_ROBLOX_MACOS_BUNDLE";
const ARGS_ENV = "JEST_ROBLOX_MACOS_ARGS";

const STUDIO_IMAGE = "RobloxStudioBeta";

const APP_EXECUTABLE_PATTERN = /^(?<bundle>.+\.app)\/Contents\/MacOS\/[^/]+$/u;

const HELPER_SCRIPT = `
ObjC.import("AppKit");
const env = $.NSProcessInfo.processInfo.environment;
const url = $.NSURL.fileURLWithPath(env.objectForKey("${BUNDLE_ENV}"));
const args = JSON.parse(ObjC.unwrap(env.objectForKey("${ARGS_ENV}")));
const configuration = $.NSMutableDictionary.dictionary;
configuration.setObjectForKey($(args), $.NSWorkspaceLaunchConfigurationArguments);
const studioEnvironment = env.mutableCopy;
studioEnvironment.removeObjectForKey("${ARGS_ENV}");
studioEnvironment.removeObjectForKey("${BUNDLE_ENV}");
configuration.setObjectForKey(studioEnvironment, $.NSWorkspaceLaunchConfigurationEnvironment);
const error = $();
const app = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError(
	url,
	0x200 | 0x80000 | 0x100,
	configuration,
	error,
);
if (app.isNil()) {
	throw new Error(ObjC.unwrap(error.localizedDescription));
}

const line = $(app.processIdentifier + "\\n").dataUsingEncoding($.NSUTF8StringEncoding);
$.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
const loop = $.NSRunLoop.currentRunLoop;
while (!app.isTerminated) {
	if (!app.isHidden && !app.isActive) {
		app.hide;
	}

	loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
}
`;

export interface MacosHiddenLaunchRequest {
	/** Studio argument vector, without the executable. */
	args: Array<string>;
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
	placeFile: string;
	studioPath: string;
}

export function findAppBundle(studioPath: string): string | undefined {
	return APP_EXECUTABLE_PATTERN.exec(studioPath)?.groups?.["bundle"];
}

export function launchHiddenOnMacos(
	request: MacosHiddenLaunchRequest,
	bundle: string,
): StudioCliProcess {
	return launchThroughHelper({
		fileSystem: request.fileSystem,
		killStudio: (pid, helper) => {
			killStudio(request.childProcess, { helper, pid });
		},
		label: "macOS hidden",
		placeFile: request.placeFile,
		spawnHelper: () => spawnHelper(request, bundle),
	});
}

function killStudio(
	childProcess: ChildProcessRunner,
	{ helper, pid }: { helper: ChildProcess; pid: number },
): void {
	const target = pid.toString();
	childProcess.execFile(
		"ps",
		["-o", "comm=", "-p", target],
		{ windowsHide: true },
		(_error, stdout) => {
			if (!stdout.trimEnd().endsWith(STUDIO_IMAGE)) {
				helper.kill();
				return;
			}

			childProcess.execFile("kill", ["-KILL", target], { windowsHide: true }, () => {
				helper.kill();
			});
		},
	);
}

function spawnHelper(request: MacosHiddenLaunchRequest, bundle: string): ChildProcess {
	return request.childProcess.spawn("osascript", ["-l", "JavaScript", "-e", HELPER_SCRIPT], {
		env: {
			...process.env,
			[ARGS_ENV]: JSON.stringify(request.args),
			[BUNDLE_ENV]: bundle,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}
