import { fromAny, fromExact, fromPartial } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, type Mock, onTestFinished, vi } from "vitest";
import type { WebSocketServer } from "ws";

import type { MockWebSocketServer as MockWebSocketServerType } from "../../test/mocks/mock-web-socket-server.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { BuildPlaceOptions } from "../staging/place-builder.ts";
import type { JestResult } from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { createStudioCliBackend, StudioCliBackend } from "./studio-cli.ts";
import type { StudioCliLauncher, StudioCliProcess } from "./studio-cli.ts";

const { getLastCreatedServer, MockWebSocket, MockWebSocketServer } = await vi.hoisted(
	async () => import("../../test/mocks/mock-ws"),
);

vi.mock(import("ws"), async () => fromPartial({ WebSocketServer: MockWebSocketServer }));

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("node:child_process"));

/**
 * A launched Studio the backend can kill. `onError` mirrors the real seam (a
 * spawn failure); `emitError` lets a test drive that failure once the backend
 * has subscribed.
 */
interface FakeProcess extends StudioCliProcess {
	emitError: (error: Error) => void;
	kill: Mock<StudioCliProcess["kill"]>;
	killOnLockRelease: Mock<StudioCliProcess["killOnLockRelease"]>;
}

interface ReplyOptions {
	entries?: Array<{ elapsedMs?: number; jestOutput: string }>;
	gameOutput?: string;
	omitProtocolVersion?: boolean;
	protocolVersion?: number;
	rawJestOutput?: string;
}

function job(displayName: string, overrides: Partial<ResolvedConfig> = {}): ProjectJob {
	return {
		config: {
			...DEFAULT_CONFIG,
			backend: "studio-cli",
			rojoProject: "default.project.json",
			rootDir: "/repo",
			...overrides,
		},
		displayColor: `${displayName}-color`,
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function successResult(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify(
		fromExact<JestResult>({
			numFailedTests: 0,
			numPassedTests: 2,
			numPendingTests: 0,
			numTotalTests: 2,
			startTime: 0,
			success: true,
			testResults: [],
			...overrides,
		}),
	);
}

function envelope(entries: Array<{ elapsedMs?: number; jestOutput: string }>): string {
	return JSON.stringify({ entries });
}

function makeFakeProcess(): FakeProcess {
	const errors = new EventEmitter();
	return {
		emitError: (error) => {
			errors.emit("error", error);
		},
		kill: vi.fn<StudioCliProcess["kill"]>(),
		killOnLockRelease: vi.fn<StudioCliProcess["killOnLockRelease"]>(),
		onError: (listener) => {
			errors.on("error", listener);
		},
	};
}

// The bootstrap bakes its `request_id` as a Luau long string
// (`local REQUEST_ID = [=[<uuid>]=]`); the reply must echo it for the host's
// correlation check to accept the frame. Read it back from the written
// bootstrap the same way real Studio would.
function readRequestId(args: Array<string>): string {
	const bootstrapPath = args[args.indexOf("--runScriptFile") + 1]!;
	const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
	return /REQUEST_ID = \[=*\[(.+?)\]=*\]/.exec(bootstrap)![1]!;
}

function resultFrame(requestId: string, reply: ReplyOptions): string {
	return JSON.stringify({
		gameOutput: reply.gameOutput ?? "[]",
		jestOutput:
			reply.rawJestOutput ?? envelope(reply.entries ?? [{ jestOutput: successResult() }]),
		request_id: requestId,
		type: "results",
		...(reply.omitProtocolVersion === true
			? {}
			: { protocolVersion: reply.protocolVersion ?? 3 }),
	});
}

/**
 * A launcher that, once the backend is listening, drives the canned result frame
 * back over the mock WebSocket server — the socket stand-in for a real bootstrap
 * pushing its envelope. `onLaunch` runs synchronously with the launch request
 * (to capture args/bootstrap before the reply).
 */
function replyWith(
	reply: ReplyOptions = {},
	onLaunch?: (request: Parameters<StudioCliLauncher>[0]) => void,
): { launch: StudioCliLauncher; process: FakeProcess } {
	const process = makeFakeProcess();
	return {
		launch: (request) => {
			onLaunch?.(request);
			queueMicrotask(() => {
				const server = getLastCreatedServer();
				if (server === undefined) {
					return;
				}

				const socket = new MockWebSocket();
				server.emit("connection", socket);
				socket.emit(
					"message",
					Buffer.from(resultFrame(readRequestId(request.args), reply)),
				);
			});
			return process;
		},
		process,
	};
}

function fakeBuildPlace(): (options: BuildPlaceOptions) => { hash: string; path: string } {
	return (options) => ({ hash: "hash", path: options.placeFile });
}

function makeBackend(
	launch: StudioCliLauncher,
	extra: Partial<ConstructorParameters<typeof StudioCliBackend>[0]> = {},
): StudioCliBackend {
	return new StudioCliBackend({
		buildPlace: fakeBuildPlace(),
		discover: () => "C:/Studio/RobloxStudioBeta.exe",
		launch,
		...extra,
	});
}

function backendReplying(reply: ReplyOptions = {}): StudioCliBackend {
	return makeBackend(replyWith(reply).launch);
}

// Workspace jobs carry `pkg` (set only in workspace mode) and a `placeFile`
// pointing at the mega-place the workspace runner already built. studio-cli
// keys off `pkg` to switch into the staged/materializer dispatch.
function workspaceJob(
	package_: string,
	displayName: string,
	overrides: Partial<ResolvedConfig> = {},
): ProjectJob {
	return {
		...job(displayName, {
			placeFile: "/repo/.jest-roblox/workspace/synthesized.rbxl",
			...overrides,
		}),
		pkg: package_,
	};
}

const singleJob: BackendOptions = { jobs: [job("")] };

function resetVol(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

describe(StudioCliBackend, () => {
	it("should run a single-project suite end-to-end and return one rawResult", async () => {
		expect.assertions(3);

		resetVol();

		const { rawResults, timing } = await backendReplying().runTests(singleJob);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain('"numPassedTests":2');
		expect(timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should return one rawResult per job, in submitted order, for a multi-project run", async () => {
		expect.assertions(2);

		resetVol();

		const backend = backendReplying({
			entries: [
				{ elapsedMs: 11, jestOutput: successResult() },
				{ elapsedMs: 22, jestOutput: successResult() },
			],
		});

		const { rawResults } = await backend.runTests({ jobs: [job("alpha"), job("beta")] });

		expect(rawResults).toHaveLength(2);
		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([11, 22]);
	});

	it("should surface the frame gameOutput as the fallback on each rawResult", async () => {
		expect.assertions(1);

		resetVol();

		const fallback = JSON.stringify([{ message: "hi", messageType: 0, timestamp: 0 }]);
		const backend = backendReplying({
			entries: [{ jestOutput: successResult() }],
			gameOutput: fallback,
		});

		const { rawResults } = await backend.runTests(singleJob);

		expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
	});

	it("should build a Clean Place with LoadStringEnabled from the rojo project", async () => {
		expect.assertions(4);

		resetVol();

		const buildPlace =
			vi.fn<(options: BuildPlaceOptions) => { hash: string; path: string }>(fakeBuildPlace());
		const backend = new StudioCliBackend({
			buildPlace,
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: replyWith().launch,
		});

		await backend.runTests(singleJob);

		const built = buildPlace.mock.calls[0]![0];

		expect(built.loadStringEnabled).toBeTrue();
		expect(built.wrap).toBeFalse();
		expect(built.packages[0]!.rojoProjectPath).toContain("default.project.json");
		expect(built.placeFile).toContain("place.rbxl");
	});

	it("should write a bootstrap that drives ExecuteRunModeAsync over a result socket", async () => {
		expect.assertions(4);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			bootstrap = fs.readFileSync(
				request.args[request.args.indexOf("--runScriptFile") + 1]!,
				"utf8",
			);
		});
		const backend = makeBackend(launch);

		await backend.runTests({ jobs: [job("alpha", { testNamePattern: "alpha-pattern" })] });

		expect(bootstrap).toContain("ExecuteRunModeAsync");
		expect(bootstrap).toContain("alpha-pattern");
		expect(bootstrap).toContain("CreateWebStreamClient");
		expect(bootstrap).toContain("ws://localhost:");
	});

	it("should escape a config value containing the Luau long-string terminator", async () => {
		// A config string with `]=]` would close a level-1 `[=[ … ]=]` long
		// string early and produce invalid Luau (a silent no-result run). The
		// bracket level must escalate so the payload round-trips intact.
		expect.assertions(2);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			bootstrap = fs.readFileSync(
				request.args[request.args.indexOf("--runScriptFile") + 1]!,
				"utf8",
			);
		});
		const backend = makeBackend(launch);

		await backend.runTests({ jobs: [job("alpha", { testNamePattern: "x]=]y" })] });

		// Level escalated to `[==[ … ]==]`, and the `]=]` payload sits intact
		// inside without closing it.
		expect(bootstrap).toContain("JSONDecode([==[");
		expect(bootstrap).toContain("x]=]y");
	});

	it("should surface a version-mismatch error when the plugin omits the protocolVersion echo", async () => {
		// A stale plugin (a runner predating the handshake) returns a valid
		// envelope but never echoes protocolVersion. The host must reject it as a
		// version mismatch ("update the plugin"), not run with stale semantics.
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({ omitProtocolVersion: true });

		await expect(backend.runTests(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should surface a version-mismatch error when the plugin echoes a different protocolVersion", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({ protocolVersion: 2 });

		await expect(backend.runTests(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should carry a large jestOutput through the socket frame intact (no print cap)", async () => {
		// The old file channel capped a single `print` at ~100k chars; the socket
		// carries the whole envelope in one frame, so a large jestOutput rides
		// through verbatim.
		expect.assertions(2);

		resetVol();

		const bigName = "x".repeat(200_000);
		const jestOutput = envelope([{ jestOutput: `{"success":true,"value":"${bigName}"}` }]);
		const backend = backendReplying({ rawJestOutput: jestOutput });

		const { rawResults } = await backend.runTests(singleJob);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain(bigName);
	});

	it("should surface a whole-run plugin error (success:false) as its message", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({
			rawJestOutput: JSON.stringify({ err: "plugin produced no result", success: false }),
		});

		await expect(backend.runTests(singleJob)).rejects.toThrow(/plugin produced no result/);
	});

	it("should ignore non-result frames and resolve on the matching result", async () => {
		// The server can see engine/plugin chatter and stray frames; only a
		// well-formed `results` frame for THIS request_id resolves the run.
		expect.assertions(1);

		resetVol();

		const process = makeFakeProcess();
		const { rawResults } = await makeBackend((request) => {
			queueMicrotask(() => {
				const server = getLastCreatedServer()!;
				const socket = new MockWebSocket();
				server.emit("connection", socket);
				// Non-JSON noise, a non-results frame, and a result for a
				// different request — each ignored — then the real one.
				socket.emit("message", Buffer.from("not json {{"));
				socket.emit("message", Buffer.from(JSON.stringify({ hello: 1, type: "log" })));
				socket.emit("message", Buffer.from(resultFrame("a-different-request", {})));
				const frame = Buffer.from(resultFrame(readRequestId(request.args), {}));
				socket.emit("message", frame);
				// A duplicate frame after the first resolves must be ignored, not
				// re-settle the run.
				socket.emit("message", frame);
			});
			return process;
		}).runTests(singleJob);

		expect(rawResults).toHaveLength(1);
	});

	it("should reject with a timeout when no result frame arrives", async () => {
		expect.assertions(2);

		resetVol();

		// A Studio that never sends a result drives the timeout path.
		const process = makeFakeProcess();
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: () => process,
			timeout: 40,
		});

		await expect(backend.runTests(singleJob)).rejects.toThrow(
			/timed out after 40ms and was terminated/,
		);
		// The run kills Studio on the way out even on the timeout path.
		expect(process.kill).toHaveBeenCalledOnce();
	});

	it("should reject when the result server errors", async () => {
		expect.assertions(1);

		resetVol();

		const process = makeFakeProcess();

		await expect(
			makeBackend(() => {
				queueMicrotask(() => {
					getLastCreatedServer()!.emit("error", new Error("EADDRINUSE"));
				});
				return process;
			}).runTests(singleJob),
		).rejects.toThrow(/EADDRINUSE/);
	});

	it("should reject when Studio fails to spawn", async () => {
		expect.assertions(1);

		resetVol();

		const process = makeFakeProcess();

		await expect(
			makeBackend(() => {
				queueMicrotask(() => {
					process.emitError(new Error("spawn ENOENT"));
				});
				return process;
			}).runTests(singleJob),
		).rejects.toThrow(/spawn ENOENT/);
	});

	it("should launch Studio with the RunScript task argument set", async () => {
		expect.assertions(2);

		resetVol();

		let captured: undefined | { args: Array<string>; studioPath: string };
		const { launch } = replyWith({}, (request) => {
			captured = { args: request.args, studioPath: request.studioPath };
		});
		const backend = makeBackend(launch);

		await backend.runTests(singleJob);

		expect(captured?.studioPath).toBe("C:/Studio/RobloxStudioBeta.exe");
		expect(captured?.args).toStrictEqual(
			expect.arrayContaining([
				"--task",
				"RunScript",
				"--localPlaceFile",
				"--runScriptFile",
				"--outputFile",
				"--quitAfterExecution",
			]),
		);
	});

	it("should forward headed=true to the launch request when constructed headed", async () => {
		expect.assertions(1);

		resetVol();

		let captured: boolean | undefined;
		const { launch } = replyWith({}, (request) => {
			captured = request.headed;
		});

		await makeBackend(launch, { headed: true }).runTests(singleJob);

		expect(captured).toBeTrue();
	});

	it("should default headed to false in the launch request", async () => {
		expect.assertions(1);

		resetVol();

		let captured: boolean | undefined;
		const { launch } = replyWith({}, (request) => {
			captured = request.headed;
		});

		await makeBackend(launch).runTests(singleJob);

		expect(captured).toBeFalse();
	});

	it("should pass the studioPath override to the discover seam", async () => {
		expect.assertions(1);

		resetVol();

		const discover = vi.fn<(override: string | undefined) => string>(
			() => "C:/Studio/RobloxStudioBeta.exe",
		);
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover,
			launch: replyWith().launch,
			studioPath: "C:/override/RobloxStudioBeta.exe",
		});

		await backend.runTests(singleJob);

		expect(discover).toHaveBeenCalledWith("C:/override/RobloxStudioBeta.exe");
	});

	it("should reject --parallel > 1 with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		await expect(backendReplying().runTests({ jobs: [job("")], parallel: 2 })).rejects.toThrow(
			/--parallel > 1 is not supported/,
		);
	});

	it("should allow --parallel of 1", async () => {
		expect.assertions(1);

		resetVol();

		const { rawResults } = await backendReplying().runTests({ jobs: [job("")], parallel: 1 });

		expect(rawResults).toHaveLength(1);
	});

	it("should reject work-stealing with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		await expect(
			backendReplying().runTests({ jobs: [job("")], workStealing: true }),
		).rejects.toThrow(/does not support work-stealing/);
	});

	it("should throw when given no jobs", async () => {
		expect.assertions(1);

		resetVol();

		await expect(backendReplying().runTests({ jobs: [] })).rejects.toThrow(
			"StudioCliBackend requires at least one job",
		);
	});

	it("should throw when the runtime returns a different entry count than jobs", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({
			entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }],
		});

		await expect(backend.runTests(singleJob)).rejects.toThrow(
			/returned 2 entries but request had 1 jobs/,
		);
	});

	it("should run a workspace config against the pre-built mega-place without building its own", async () => {
		expect.assertions(2);

		resetVol();

		const buildPlace =
			vi.fn<(options: BuildPlaceOptions) => { hash: string; path: string }>(fakeBuildPlace());
		let localPlaceFile = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			localPlaceFile = request.args[request.args.indexOf("--localPlaceFile") + 1]!;
		});
		const backend = new StudioCliBackend({
			buildPlace,
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch,
		});

		await backend.runTests({ jobs: [workspaceJob("@scope/a", "a")] });

		// The mega-place is already built by the workspace runner; studio-cli
		// must drive it, not build a second place from one package's rojo
		// project.
		expect(buildPlace).not.toHaveBeenCalled();
		expect(localPlaceFile).toContain("synthesized.rbxl");
	});

	it("should drive the staged workspace entries (pkg/project per job), not a configs payload", async () => {
		expect.assertions(3);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith(
			{
				entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }],
			},
			(request) => {
				bootstrap = fs.readFileSync(
					request.args[request.args.indexOf("--runScriptFile") + 1]!,
					"utf8",
				);
			},
		);
		const backend = makeBackend(launch);

		await backend.runTests({
			jobs: [workspaceJob("@scope/a", "a"), workspaceJob("@scope/b", "b")],
		});

		expect(bootstrap).toContain("workspace");
		expect(bootstrap).toContain("@scope/a");
		expect(bootstrap).toContain("@scope/b");
	});

	it("should return one rawResult per workspace package, in submitted order", async () => {
		expect.assertions(2);

		resetVol();

		const backend = backendReplying({
			entries: [
				{ elapsedMs: 5, jestOutput: successResult() },
				{ elapsedMs: 7, jestOutput: successResult() },
			],
		});

		const { rawResults } = await backend.runTests({
			jobs: [workspaceJob("@scope/a", "a"), workspaceJob("@scope/b", "b")],
		});

		expect(rawResults).toHaveLength(2);
		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([5, 7]);
	});

	it("should construct with default seams via createStudioCliBackend", () => {
		expect.assertions(1);

		expect(createStudioCliBackend().kind).toBe("studio-cli");
	});

	it("should resolve the studioPath override through the default discover seam", async () => {
		expect.assertions(1);

		resetVol();

		vol.fromJSON({ "C:/seeded/RobloxStudioBeta.exe": "binary" });
		let launchedPath = "";
		const { launch } = replyWith({}, (request) => {
			launchedPath = request.studioPath;
		});
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			launch,
			studioPath: "C:/seeded/RobloxStudioBeta.exe",
		});

		await backend.runTests(singleJob);

		expect(launchedPath).toBe("C:/seeded/RobloxStudioBeta.exe");
	});

	it("should fall back to JEST_ROBLOX_STUDIO_PATH when no override is given", async () => {
		expect.assertions(1);

		resetVol();

		vi.stubEnv("JEST_ROBLOX_STUDIO_PATH", "C:/from-env/RobloxStudioBeta.exe");
		vol.fromJSON({ "C:/from-env/RobloxStudioBeta.exe": "binary" });
		let launchedPath = "";
		const { launch } = replyWith({}, (request) => {
			launchedPath = request.studioPath;
		});
		const backend = new StudioCliBackend({ buildPlace: fakeBuildPlace(), launch });

		await backend.runTests(singleJob);

		expect(launchedPath).toBe("C:/from-env/RobloxStudioBeta.exe");
	});

	describe("result server port", () => {
		// The default ephemeral-port path: a real `ws` server binds
		// asynchronously, so the backend waits for `listening` then reads the
		// assigned port. These drive that path with a fake server (the mock
		// reports its port up front and is returned without waiting).
		function pendingServer(boundPort: number | undefined): WebSocketServer {
			const server: MockWebSocketServerType = new MockWebSocketServer({ port: 0 });
			// Report "not yet bound" until `listening` fires, then the assigned
			// port. State on an object so the lazy implementation re-reads it.
			const state = { listening: false };
			vi.spyOn(server, "address").mockImplementation(() => {
				if (state.listening && boundPort !== undefined) {
					return { port: boundPort };
				}

				return fromAny(null);
			});
			queueMicrotask(() => {
				state.listening = true;
				server.emit("listening");
			});
			return fromAny(server);
		}

		it("should wait for `listening` and bake the assigned ephemeral port", async () => {
			expect.assertions(1);

			resetVol();

			let bootstrap = "";
			const { launch } = replyWith({}, (request) => {
				bootstrap = fs.readFileSync(
					request.args[request.args.indexOf("--runScriptFile") + 1]!,
					"utf8",
				);
			});
			const backend = new StudioCliBackend({
				buildPlace: fakeBuildPlace(),
				createServer: () => pendingServer(54_321),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch,
			});

			await backend.runTests(singleJob);

			expect(bootstrap).toContain("ws://localhost:54321");
		});

		it("should throw when the result server never reports a bound port", async () => {
			expect.assertions(1);

			resetVol();

			const backend = new StudioCliBackend({
				buildPlace: fakeBuildPlace(),
				createServer: () => pendingServer(undefined),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch: replyWith().launch,
			});

			await expect(backend.runTests(singleJob)).rejects.toThrow(/failed to bind a port/);
		});
	});

	describe("coverage", () => {
		function coverageJob(): ProjectJob {
			return job("", {
				collectCoverage: true,
				placeFile: ".jest-roblox/coverage/game.rbxl",
			});
		}

		it("should open the coverage-instrumented place instead of building a Clean Place", async () => {
			expect.assertions(2);

			resetVol();

			const buildPlace =
				vi.fn<(options: BuildPlaceOptions) => { hash: string; path: string }>(
					fakeBuildPlace(),
				);
			let localPlaceFile = "";
			const { launch } = replyWith(
				{ entries: [{ jestOutput: successResult() }] },
				(request) => {
					localPlaceFile = request.args[request.args.indexOf("--localPlaceFile") + 1]!;
				},
			);
			const backend = new StudioCliBackend({
				buildPlace,
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch,
			});

			await backend.runTests({ jobs: [coverageJob()] });

			// Exact path (not just `toContain`) so a rootDir/CWD resolution
			// drift is caught, and the clean place is provably never built.
			expect(localPlaceFile).toBe(
				normalizeWindowsPath(path.resolve("/repo", ".jest-roblox/coverage/game.rbxl")),
			);
			expect(buildPlace).not.toHaveBeenCalled();
		});

		it("should carry the runtime coverage data through to the rawResult entry", async () => {
			expect.assertions(1);

			resetVol();

			const coverageData = { "ReplicatedStorage/mod": { f: {}, s: { "1": 1 } } };
			const jestOutput = successResult({ _coverage: coverageData });
			const backend = backendReplying({ entries: [{ jestOutput }] });

			const { rawResults } = await backend.runTests({ jobs: [coverageJob()] });

			// The coverage-bearing jestOutput rides through verbatim, so the
			// downstream parser/mapper produce the report exactly as on
			// open-cloud.
			expect(rawResults[0]!.entry.jestOutput).toBe(jestOutput);
		});
	});

	describe("graceful shutdown", () => {
		it("should, by default, kill on lock release rather than instant-kill", async () => {
			expect.assertions(2);

			resetVol();

			const { launch, process } = replyWith();

			await makeBackend(launch).runTests(singleJob);

			// Default ON: hand teardown to the lock-release watch (which lets
			// edit- mode BindToClose run + frees the lock) instead of
			// TerminateProcess.
			expect(process.killOnLockRelease).toHaveBeenCalledOnce();
			expect(process.kill).not.toHaveBeenCalled();
		});

		it("should pass the configured grace cap to the lock-release watch", async () => {
			expect.assertions(1);

			resetVol();

			const { launch, process } = replyWith();

			await makeBackend(launch, { gracefulShutdownTimeout: 9999 }).runTests(singleJob);

			expect(process.killOnLockRelease).toHaveBeenCalledWith(9999);
		});

		it("should let the background watch own teardown when a post-result check throws", async () => {
			// The result frame landed (Studio is idle and gracefully closeable),
			// so even though the protocol check then rejects the run, the
			// graceful watch already owns the kill — the run must not also
			// hard-kill.
			expect.assertions(3);

			resetVol();

			const { launch, process } = replyWith({ protocolVersion: 2 });

			await expect(makeBackend(launch).runTests(singleJob)).rejects.toThrow(
				/protocol.*mismatch/i,
			);
			expect(process.killOnLockRelease).toHaveBeenCalledOnce();
			expect(process.kill).not.toHaveBeenCalled();
		});
	});

	describe("default launcher (spawnStudio)", () => {
		// The real spawnStudio clears a stale lock, spawns Studio, and returns a
		// handle the host can kill; the result arrives over the (mock) server.
		// The fake child is an EventEmitter with a `kill` spy and `error` event.
		class FakeChild extends EventEmitter {
			public readonly kill = vi.fn<ChildProcess["kill"]>();
		}

		function stubSpawn(): { args: () => Array<string>; child: FakeChild } {
			const child = new FakeChild();
			let capturedArgs: Array<string> = [];
			vi.mocked(spawn).mockImplementation(((_file: string, args: Array<string>) => {
				capturedArgs = args;
				return child as unknown as ChildProcess;
			}) as unknown as typeof spawn);
			return { args: () => capturedArgs, child };
		}

		function backendWithDefaultLaunch(
			extra: Partial<ConstructorParameters<typeof StudioCliBackend>[0]> = {},
		): StudioCliBackend {
			return new StudioCliBackend({
				buildPlace: fakeBuildPlace(),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				...extra,
			});
		}

		// The `<place>.lock` the real spawnStudio clears pre-launch and the
		// graceful watch polls for release.
		const lockPath = `${path.join(path.resolve("/repo"), ".jest-roblox", "studio-cli", "place.rbxl")}.lock`;

		// Drive the result frame back over the server once the backend is
		// listening (the real spawnStudio does not reply on its own).
		async function replyOverServer(args: () => Array<string>): Promise<void> {
			await Promise.resolve();
			const server = getLastCreatedServer()!;
			const socket = new MockWebSocket();
			server.emit("connection", socket);
			socket.emit("message", Buffer.from(resultFrame(readRequestId(args()), {})));
		}

		// Fake setInterval/Date only (not the microtask queue the result reply
		// rides on), so the background lock-poll is fully under timer control
		// while the canned frame still lands normally.
		function useLockPollTimers(): void {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
			onTestFinished(() => {
				vi.useRealTimers();
			});
		}

		it("should spawn Studio and return its result", async () => {
			expect.assertions(2);

			resetVol();
			useLockPollTimers();

			const { args } = stubSpawn();
			const promise = backendWithDefaultLaunch().runTests(singleJob);
			await replyOverServer(args);
			const { rawResults } = await promise;

			expect(rawResults).toHaveLength(1);
			expect(args()).toContain("RunScript");
		});

		it("should clear a stale place lock a killed Studio left behind before launching", async () => {
			expect.assertions(1);

			resetVol();
			useLockPollTimers();

			// A killed Studio cannot remove its own `<place>.lock`; the next run
			// must, or its Studio opens onto the stale lock and crashes.
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
			fs.writeFileSync(lockPath, "stale lock from a killed Studio");

			const { args } = stubSpawn();
			const promise = backendWithDefaultLaunch().runTests(singleJob);
			await replyOverServer(args);
			await promise;

			expect(fs.existsSync(lockPath)).toBeFalse();
		});

		it("should reject when Studio fails to spawn", async () => {
			expect.assertions(1);

			resetVol();

			const { child } = stubSpawn();
			const promise = backendWithDefaultLaunch().runTests(singleJob);
			await Promise.resolve();
			child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

			await expect(promise).rejects.toThrow(/spawn ENOENT/);
		});

		it("should kill Studio and reject when no result arrives before the timeout", async () => {
			expect.assertions(2);

			resetVol();

			const { child } = stubSpawn();

			await expect(
				backendWithDefaultLaunch({ timeout: 40 }).runTests(singleJob),
			).rejects.toThrow(/timed out after 40ms and was terminated/);
			expect(child.kill).toHaveBeenCalledOnce();
		});

		describe("graceful kill on lock release", () => {
			it("should kill the instant Studio releases the place lock", async () => {
				expect.assertions(2);

				resetVol();
				useLockPollTimers();

				const { args, child } = stubSpawn();
				const promise = backendWithDefaultLaunch().runTests(singleJob);
				await replyOverServer(args);
				await promise;

				// Studio holds the lock through the graceful ClosePlace; the
				// watch must wait, not kill.
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });
				fs.writeFileSync(lockPath, "held by a closing Studio");
				await vi.advanceTimersByTimeAsync(1000);

				expect(child.kill).not.toHaveBeenCalled();

				// ClosePlace releases the lock → kill fires on the next poll.
				fs.rmSync(lockPath);
				await vi.advanceTimersByTimeAsync(1000);

				expect(child.kill).toHaveBeenCalledOnce();
			});

			it("should hard-kill after the grace cap when the lock is never released", async () => {
				expect.assertions(2);

				resetVol();
				useLockPollTimers();

				const { args, child } = stubSpawn();
				const promise = backendWithDefaultLaunch({
					gracefulShutdownTimeout: 5000,
				}).runTests(singleJob);
				await replyOverServer(args);
				await promise;

				// A long-yielding BindToClose keeps the lock held past the cap.
				fs.mkdirSync(path.dirname(lockPath), { recursive: true });
				fs.writeFileSync(lockPath, "never released");
				await vi.advanceTimersByTimeAsync(4000);

				expect(child.kill).not.toHaveBeenCalled();

				await vi.advanceTimersByTimeAsync(1000);

				expect(child.kill).toHaveBeenCalledOnce();
			});
		});
	});
});
