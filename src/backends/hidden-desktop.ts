import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import process from "node:process";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { launchThroughHelper } from "./hidden-helper.ts";
import type { StudioCliProcess } from "./studio-cli.ts";

const HIDDEN_DESKTOP_NAME = "jest-roblox-studio";

const DESKTOP_ENV = "JEST_ROBLOX_HIDDEN_DESKTOP";
const APPLICATION_ENV = "JEST_ROBLOX_HIDDEN_DESKTOP_APPLICATION";
const COMMAND_LINE_ENV = "JEST_ROBLOX_HIDDEN_DESKTOP_COMMAND_LINE";

const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class JestRobloxHiddenDesktop {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct StartupInfo {
		public int cb;
		public string reserved;
		public string desktop;
		public string title;
		public int x, y, width, height, xChars, yChars, fill, flags;
		public short show, reserved2;
		public IntPtr reserved3, stdIn, stdOut, stdErr;
	}

	[StructLayout(LayoutKind.Sequential)]
	struct ProcessInformation {
		public IntPtr process, thread;
		public int processId, threadId;
	}

	[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attributes);

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startupInfo, out ProcessInformation information);

	[DllImport("kernel32.dll")]
	static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

	[DllImport("kernel32.dll")]
	static extern bool CloseHandle(IntPtr handle);

	public static void Launch(string desktop, string application, string commandLine) {
		if (CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero) == IntPtr.Zero) {
			throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktopW failed");
		}

		var startupInfo = new StartupInfo();
		startupInfo.cb = Marshal.SizeOf(startupInfo);
		startupInfo.desktop = "WinSta0\\\\" + desktop;
		ProcessInformation information;
		if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startupInfo, out information)) {
			throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
		}

		Console.Out.WriteLine(information.processId);
		Console.Out.Flush();
		WaitForSingleObject(information.process, 0xFFFFFFFF);
		CloseHandle(information.thread);
		CloseHandle(information.process);
	}
}
'@
$desktop = $env:${DESKTOP_ENV}
$application = $env:${APPLICATION_ENV}
$commandLine = $env:${COMMAND_LINE_ENV}
Remove-Item Env:${DESKTOP_ENV}, Env:${APPLICATION_ENV}, Env:${COMMAND_LINE_ENV}
[JestRobloxHiddenDesktop]::Launch($desktop, $application, $commandLine)
`;

const NEEDS_QUOTES_PATTERN = /[\s"]/u;

export interface HiddenDesktopLaunchRequest {
	/** Studio argument vector, without the executable. */
	args: Array<string>;
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
	placeFile: string;
	studioPath: string;
}

export function launchOnHiddenDesktop(request: HiddenDesktopLaunchRequest): StudioCliProcess {
	return launchThroughHelper({
		fileSystem: request.fileSystem,
		killStudio: (pid) => {
			killStudio(request.childProcess, pid);
		},
		label: "hidden desktop",
		placeFile: request.placeFile,
		spawnHelper: () => spawnHelper(request),
	});
}

function killStudio(childProcess: ChildProcessRunner, pid: number): void {
	childProcess.execFile(
		"taskkill",
		["/PID", pid.toString(), "/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/F"],
		{ windowsHide: true },
		() => {
			// Fails when Studio already exited or the PID names another image.
		},
	);
}

/**
 * Quote one argument so `CommandLineToArgvW` (the MSVC CRT rules Studio
 * parses with) reads it back unchanged.
 */
function quoteWindowsArgument(argument: string): string {
	if (argument !== "" && !NEEDS_QUOTES_PATTERN.test(argument)) {
		return argument;
	}

	let quoted = '"';
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}

		quoted += character === '"' ? "\\".repeat(backslashes * 2 + 1) : "\\".repeat(backslashes);
		quoted += character;
		backslashes = 0;
	}

	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function buildWindowsCommandLine(argv: ReadonlyArray<string>): string {
	return argv.map(quoteWindowsArgument).join(" ");
}

function spawnHelper(request: HiddenDesktopLaunchRequest): ChildProcess {
	return request.childProcess.spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64"),
		],
		{
			env: {
				...process.env,
				[APPLICATION_ENV]: request.studioPath,
				[COMMAND_LINE_ENV]: buildWindowsCommandLine([request.studioPath, ...request.args]),
				[DESKTOP_ENV]: HIDDEN_DESKTOP_NAME,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
}
