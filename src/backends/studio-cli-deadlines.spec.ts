import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";
import { fromPartial } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, it, type TestContext, vi } from "vitest";
import type { WebSocket } from "ws";

import { MockWebSocket } from "#test/helpers/unit/mock-web-socket.ts";
import {
	startNilReturnRelay,
	startProcessWatch,
	startRunDeadlines,
} from "./studio-cli-deadlines.ts";

const OUTPUT_FILE = path.resolve("/repo/.jest-roblox/studio-cli/output.log");

function useFakeTimers(onTestFinished: TestContext["onTestFinished"]): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

function deadlines({ bootTimeout = 100 } = {}) {
	const { fileSystem, volume } = createMemoryFileSystem();
	const onExpired = vi.fn<(error: Error) => void>();
	const started = startRunDeadlines({
		bootTimeout,
		fileSystem,
		onExpired,
		outputFile: OUTPUT_FILE,
		timeout: 40,
	});
	return { onExpired, started, volume };
}

function expiredMessage(onExpired: ReturnType<typeof deadlines>["onExpired"]): string {
	return onExpired.mock.calls[0]![0].message;
}

describe(startRunDeadlines, () => {
	it("should quote Studio's own log when the run never starts", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { onExpired, volume } = deadlines({ bootTimeout: 40 });
		volume.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
		volume.writeFileSync(
			OUTPUT_FILE,
			[
				"discarded oldest line",
				..."line 1\nline 2\nline 3\nline 4\nline 5\n  line 6  ".split("\n"),
				"  ",
				..."line 7\nline 8\nline 9\nline 10\nline 11\nline 12".split("\n"),
				"x".repeat(300),
				"x".repeat(301),
				"final line",
			].join("\r\n"),
		);
		vi.advanceTimersByTime(40);

		expect(expiredMessage(onExpired)).toBe(
			[
				"studio-cli: Studio did not start the run within 40ms and was terminated.",
				"  Probable cause: Studio is not logged in. Open Roblox Studio, log in, then run again.",
				"  On a slow machine, set JEST_ROBLOX_STUDIO_BOOT_TIMEOUT to allow a slower boot.",
				`  Studio log: ${OUTPUT_FILE}`,
				"  Last lines Studio logged:",
				...Array.from({ length: 12 }, (_, index) => `    line ${String(index + 1)}`),
				`    ${"x".repeat(300)}`,
				`    ${"x".repeat(300)}…`,
				"    final line",
			].join("\n"),
		);
	});

	it("should not restart the run timeout on a repeated start", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { onExpired, started } = deadlines();
		started.markStarted();
		vi.advanceTimersByTime(30);
		started.markStarted();
		vi.advanceTimersByTime(10);

		expect(expiredMessage(onExpired)).toBe(
			`studio-cli: Studio run timed out after 40ms and was terminated.\n  Studio log: ${OUTPUT_FILE}`,
		);
	});

	it("should arm nothing after it is cleared", ({ expect, onTestFinished }) => {
		expect.assertions(2);

		useFakeTimers(onTestFinished);
		const { onExpired, started } = deadlines();
		started.clear();
		started.markStarted();

		expect(vi.getTimerCount()).toBe(0);
		expect(onExpired).not.toHaveBeenCalled();
	});
});

function relay(pluginKey?: string) {
	const { fileSystem } = createMemoryFileSystem();
	const onExpired = vi.fn<(error: Error) => void>();
	const nilRelay = startNilReturnRelay({
		fileSystem,
		onExpired,
		outputFile: OUTPUT_FILE,
		pluginKey,
		requestId: "request-1",
	});
	return { nilRelay, onExpired };
}

function pluginSocket(): MockWebSocket & WebSocket {
	return fromPartial(new MockWebSocket());
}

describe(startNilReturnRelay, () => {
	it("should relay the nil return to a plugin that connected before it", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { nilRelay } = relay();
		const socket = pluginSocket();
		nilRelay.onPluginReady(socket);
		nilRelay.onNilReturn();

		expect(socket.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ requestId: "request-1", type: "nilRelay" }),
		);
	});

	it("should arm one plugin wait however many nil returns arrive", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { nilRelay } = relay();
		nilRelay.onNilReturn();
		nilRelay.onNilReturn();

		expect(vi.getTimerCount()).toBe(1);
	});

	it("should name the plugin key no copy answered for", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { nilRelay, onExpired } = relay("1.2.3-abcdef01");
		nilRelay.onNilReturn();
		vi.runAllTimers();

		expect(onExpired.mock.calls[0]![0].message).toContain(
			"No copy of the Studio plugin 1.2.3-abcdef01 answered",
		);
	});

	it("should name a play server that never ran as a cause", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		useFakeTimers(onTestFinished);
		const { nilRelay, onExpired } = relay("1.2.3-abcdef01");
		nilRelay.onNilReturn();
		vi.runAllTimers();

		expect(onExpired.mock.calls[0]![0].message).toContain(
			"the play server never started running",
		);
	});
});

describe(startProcessWatch, () => {
	it("should quote Studio's log when Studio exits and no result follows", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		useFakeTimers(onTestFinished);
		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
		volume.writeFileSync(OUTPUT_FILE, "studio-cli: failed to open result socket: full\n");
		const onExpired = vi.fn<(error: Error) => void>();
		const exits: Array<() => void> = [];
		startProcessWatch({
			child: fromPartial({
				onError: vi.fn<(listener: (error: Error) => void) => void>(),
				onExit: (listener: () => void) => {
					exits.push(listener);
				},
			}),
			fileSystem,
			onExpired,
			outputFile: OUTPUT_FILE,
		});
		exits[0]!();
		vi.advanceTimersByTime(1999);

		expect(onExpired).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);

		expect(expiredMessage(onExpired)).toBe(
			[
				"studio-cli: Studio exited before it sent a result.",
				`  Studio log: ${OUTPUT_FILE}`,
				"  Last lines Studio logged:",
				"    studio-cli: failed to open result socket: full",
			].join("\n"),
		);
	});
});
