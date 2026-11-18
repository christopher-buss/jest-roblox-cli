import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import process from "node:process";

import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { HiddenLaunchRequest } from "./hidden-helper.ts";
import { launchThroughHelper } from "./hidden-helper.ts";
import type { StudioCliProcess } from "./studio-cli-types.ts";

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
	const uint CreateSuspended = 0x4;
	const uint JobObjectLimitKillOnJobClose = 0x2000;
	const int JobObjectExtendedLimitInformationClass = 9;
	const uint ResumeThreadFailed = 0xFFFFFFFF;

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

	[StructLayout(LayoutKind.Sequential)]
	struct BasicLimitInformation {
		public long perProcessUserTimeLimit, perJobUserTimeLimit;
		public uint limitFlags;
		public UIntPtr minimumWorkingSetSize, maximumWorkingSetSize;
		public uint activeProcessLimit;
		public UIntPtr affinity;
		public uint priorityClass, schedulingClass;
	}

	[StructLayout(LayoutKind.Sequential)]
	struct ExtendedLimitInformation {
		public BasicLimitInformation basic;
		public ulong readOperations, writeOperations, otherOperations, readTransfer, writeTransfer, otherTransfer;
		public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemoryUsed, peakJobMemoryUsed;
	}

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

	[DllImport("kernel32.dll", SetLastError = true)]
	static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int length);

	[DllImport("kernel32.dll", SetLastError = true)]
	static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

	[DllImport("kernel32.dll", SetLastError = true)]
	static extern uint ResumeThread(IntPtr thread);

	[DllImport("kernel32.dll")]
	static extern bool TerminateProcess(IntPtr process, uint exitCode);

	[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attributes);

	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startupInfo, out ProcessInformation information);

	[DllImport("kernel32.dll")]
	static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

	[DllImport("kernel32.dll")]
	static extern bool CloseHandle(IntPtr handle);

	static void Abandon(ProcessInformation information, string api) {
		var error = Marshal.GetLastWin32Error();
		TerminateProcess(information.process, 1);
		throw new Win32Exception(error, api + " failed");
	}

	public static void Launch(string desktop, string application, string commandLine) {
		if (CreateDesktopW(desktop, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, IntPtr.Zero) == IntPtr.Zero) {
			throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktopW failed");
		}

		var startupInfo = new StartupInfo();
		startupInfo.cb = Marshal.SizeOf(startupInfo);
		startupInfo.desktop = "WinSta0\\\\" + desktop;
		ProcessInformation information;
		if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CreateSuspended, IntPtr.Zero, null, ref startupInfo, out information)) {
			throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
		}

		var job = CreateJobObjectW(IntPtr.Zero, null);
		if (job == IntPtr.Zero) {
			Abandon(information, "CreateJobObjectW");
		}

		var info = new ExtendedLimitInformation();
		info.basic.limitFlags = JobObjectLimitKillOnJobClose;
		if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, ref info, Marshal.SizeOf(info))) {
			Abandon(information, "SetInformationJobObject");
		}

		if (!AssignProcessToJobObject(job, information.process)) {
			Abandon(information, "AssignProcessToJobObject");
		}

		if (ResumeThread(information.thread) == ResumeThreadFailed) {
			Abandon(information, "ResumeThread");
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

/**
 * Launch Studio on a hidden Windows desktop.
 *
 * @param request - Studio path, arguments, place file, and process runner.
 * @returns A handle that kills Studio and reports launch failures.
 */
export function launchOnHiddenDesktop(request: HiddenLaunchRequest): StudioCliProcess {
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
 * Must match the `CommandLineToArgvW` rules Studio parses its arguments with.
 *
 * @param argument - One argument for the Studio command line.
 * @returns The argument, quoted when it holds whitespace or a quote.
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

function spawnHelper(request: HiddenLaunchRequest): ChildProcess {
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
