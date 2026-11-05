import { fromAny } from "@total-typescript/shoehorn";

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import nodeProcess from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { MockWebSocketServer } from "#test/mocks/mock-web-socket-server.ts";
import { MockWebSocket } from "#test/mocks/mock-web-socket.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import {
	hardTeardown,
	launchStudioProcess,
	resolveHiddenDesktop,
	startGracefulTeardown,
} from "./studio-cli-process.ts";
import type { StudioCliLaunchRequest, StudioCliProcess } from "./studio-cli-types.ts";

function fakeProcess() {
	return {
		kill: vi.fn<() => void>(),
		killOnLockRelease: vi.fn<(graceCapMs: number) => void>(),
		onError: vi.fn<StudioCliProcess["onError"]>(),
	};
}

function serverWithClient() {
	const server = new MockWebSocketServer({ port: 0 });
	const client = new MockWebSocket();
	server.emit("connection", client);
	return { client, server };
}

describe(resolveHiddenDesktop, () => {
	it.for([
		["win32", undefined, true],
		["darwin", undefined, true],
		["linux", undefined, false],
		["win32", true, true],
		["darwin", true, true],
		["win32", false, false],
		["darwin", false, false],
	] as const)(
		"should resolve hiddenDesktop on %s from %j to %j",
		([platform, hiddenDesktop, expected]) => {
			expect.assertions(2);

			const stderr = vi.spyOn(nodeProcess.stderr, "write").mockReturnValue(true);

			expect(resolveHiddenDesktop({ hiddenDesktop, platform })).toBe(expected);
			expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("hiddenDesktop"));
		},
	);

	it("should ignore an explicit hiddenDesktop with a warning on Linux", () => {
		expect.assertions(2);

		const stderr = vi.spyOn(nodeProcess.stderr, "write").mockReturnValue(true);

		expect(resolveHiddenDesktop({ hiddenDesktop: true, platform: "linux" })).toBeFalse();
		expect(stderr).toHaveBeenCalledWith(
			"Warning: hiddenDesktop is Windows and macOS only; ignoring it.\n",
		);
	});

	it("should let headed win over hiddenDesktop", () => {
		expect.assertions(1);

		expect(
			resolveHiddenDesktop({ headed: true, hiddenDesktop: true, platform: "win32" }),
		).toBeFalse();
	});
});

describe(hardTeardown, () => {
	it("should kill Studio and close the result server", () => {
		expect.assertions(3);

		const child = fakeProcess();
		const { client, server } = serverWithClient();
		hardTeardown(child, fromAny(server));

		expect(child.kill).toHaveBeenCalledOnce();
		expect(client.terminate).toHaveBeenCalledOnce();
		expect(server.close).toHaveBeenCalledOnce();
	});

	it("should close the result server when Studio never launched", () => {
		expect.assertions(1);

		const { server } = serverWithClient();
		hardTeardown(undefined, fromAny(server));

		expect(server.close).toHaveBeenCalledOnce();
	});
});

describe(startGracefulTeardown, () => {
	it("should close the result server and hand the kill to the lock-release watch", () => {
		expect.assertions(3);

		const child = fakeProcess();
		const { server } = serverWithClient();
		startGracefulTeardown({ child, graceCapMs: 9999, server: fromAny(server) });

		expect(server.close).toHaveBeenCalledOnce();
		expect(child.killOnLockRelease).toHaveBeenCalledExactlyOnceWith(9999);
		expect(child.kill).not.toHaveBeenCalled();
	});
});

describe(launchStudioProcess, () => {
	it("should spawn Studio directly when it is not hidden", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const child = Object.assign(new EventEmitter(), {
			kill: vi.fn<ChildProcess["kill"]>(),
			unref: vi.fn<ChildProcess["unref"]>(),
		});
		const spawn = vi.fn<(...args: Array<unknown>) => typeof child>(() => child);
		const request: StudioCliLaunchRequest = {
			args: ["--task", "RunScript"],
			childProcess: fromAny<ChildProcessRunner, unknown>({ spawn }),
			fileSystem,
			headed: true,
			hiddenDesktop: false,
			placeFile: "/repo/place.rbxl",
			platform: "win32",
			studioPath: "C:/Studio/RobloxStudioBeta.exe",
		};

		launchStudioProcess(request).kill();

		expect(spawn).toHaveBeenCalledExactlyOnceWith(
			"C:/Studio/RobloxStudioBeta.exe",
			["--task", "RunScript"],
			{ stdio: "ignore", windowsHide: false },
		);
		expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
	});
});
