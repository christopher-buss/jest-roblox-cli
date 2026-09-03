import { fromAny, fromExact, fromPartial } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it, type Mock, onTestFinished, vi } from "vitest";
import type { WebSocketServer } from "ws";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
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
	pluginVersion?: string;
	protocolVersion?: number;
	rawJestOutput?: string;
}

// The protocol this CLI speaks, pinned here on purpose: the spec asserts the
// wire, so a bump has to be made deliberately in both places.
const PROTOCOL_VERSION = 7;

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

function successResult(
	overrides: Partial<JestResult> & { runner?: { coverage?: RawCoverageData } } = {},
): string {
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

// The lock-poll interval never arms on the timeout path — a hung run gets no
// graceful wait — so setTimeout is the only timer worth faking here.
function useResultDeadlineTimers(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	onTestFinished(() => {
		vi.useRealTimers();
	});
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

// The bootstrap bakes its `requestId` as a Luau long string
// (`local REQUEST_ID = [=[<uuid>]=]`); the reply must echo it for the host's
// correlation check to accept the frame. Read it back from the written
// bootstrap the same way real Studio would.
function readRequestId(args: Array<string>): string {
	const bootstrapPath = args[args.indexOf("--runScriptFile") + 1]!;
	const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
	return /REQUEST_ID = \[=*\[(.+?)\]=*\]/.exec(bootstrap)![1]!;
}

function readOutputFile(args: Array<string>): string {
	return args[args.indexOf("--outputFile") + 1]!;
}

function resultFrame(requestId: string, reply: ReplyOptions): string {
	const frame = {
		gameOutput: reply.gameOutput ?? "[]",
		jestOutput:
			reply.rawJestOutput ?? envelope(reply.entries ?? [{ jestOutput: successResult() }]),
		requestId,
		type: "results",
	};
	return JSON.stringify(
		reply.omitProtocolVersion === true
			? frame
			: {
					...frame,
					pluginVersion: reply.pluginVersion,
					protocolVersion: reply.protocolVersion ?? PROTOCOL_VERSION,
				},
	);
}

/**
 * A launcher that, once the backend is listening, drives the canned result
 * frame back over the mock WebSocket server — the socket stand-in for a real
 * bootstrap pushing its envelope. `onLaunch` runs synchronously with the
 * launch request (to capture args/bootstrap before the reply).
 */
function replyWith(
	reply: ReplyOptions = {},
	onLaunch?: (request: Parameters<StudioCliLauncher>[0]) => void,
) {
	const process = makeFakeProcess();
	return {
		launch: (request: Parameters<StudioCliLauncher>[0]) => {
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

function fakeBuildPlace(): (options: BuildPlaceOptions) => Promise<BuildManifestArtifact> {
	return async (options) => ({ hash: "hash", path: options.placeFile });
}

function makeBackend(
	launch: StudioCliLauncher,
	extra: Partial<ConstructorParameters<typeof StudioCliBackend>[0]> = {},
): StudioCliBackend {
	return new StudioCliBackend({
		buildPlaceAsync: fakeBuildPlace(),
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
	packageName: string,
	displayName: string,
	overrides: Partial<ResolvedConfig> = {},
): ProjectJob {
	return {
		...job(displayName, {
			placeFile: "/repo/.jest-roblox/workspace/synthesized.rbxl",
			...overrides,
		}),
		pkg: packageName,
	};
}

/** Microtask turns the place build in front of the server can cost. */
const SERVER_TURNS = 50;

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
		const now = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
		onTestFinished(() => {
			now.mockRestore();
		});

		const { rawResults, timing } = await backendReplying().runTestsAsync(singleJob);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain('"numPassedTests":2');
		expect(timing).toStrictEqual({ executionMs: 45 });
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

		const { rawResults } = await backend.runTestsAsync({ jobs: [job("alpha"), job("beta")] });

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

		const { rawResults } = await backend.runTestsAsync(singleJob);

		expect(rawResults[0]!.fallbackGameOutput).toBe(fallback);
	});

	it("should carry the requested VM count in the bootstrap payload", async () => {
		expect.assertions(1);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith(
			{ entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }] },
			(request) => {
				bootstrap = fs.readFileSync(
					request.args[request.args.indexOf("--runScriptFile") + 1]!,
					"utf8",
				);
			},
		);

		await makeBackend(launch).runTestsAsync({
			jobs: [job("alpha"), job("beta")],
			vmParallel: 2,
		});

		expect(bootstrap).toContain('"vmParallel":2');
	});

	it("should tell the plugin the run budget it must finish inside", async () => {
		expect.assertions(1);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith(
			{ entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }] },
			(request) => {
				bootstrap = fs.readFileSync(
					request.args[request.args.indexOf("--runScriptFile") + 1]!,
					"utf8",
				);
			},
		);

		await makeBackend(launch, { timeout: 120_000 }).runTestsAsync({
			jobs: [job("alpha"), job("beta")],
			vmParallel: 2,
		});

		expect(bootstrap).toContain('"runBudgetMs":120000');
	});

	it("should omit the VM count from the bootstrap payload when not vm-parallel", async () => {
		expect.assertions(1);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			bootstrap = fs.readFileSync(
				request.args[request.args.indexOf("--runScriptFile") + 1]!,
				"utf8",
			);
		});

		await makeBackend(launch).runTestsAsync(singleJob);

		expect(bootstrap).not.toContain("vmParallel");
	});

	it("should build a Clean Place with LoadStringEnabled from the rojo project", async () => {
		expect.assertions(4);

		resetVol();

		const buildPlaceAsync =
			vi.fn<(options: BuildPlaceOptions) => Promise<BuildManifestArtifact>>(fakeBuildPlace());
		const backend = new StudioCliBackend({
			buildPlaceAsync,
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: replyWith().launch,
		});

		await backend.runTestsAsync(singleJob);

		const built = buildPlaceAsync.mock.calls[0]![0];

		expect(built.loadStringEnabled).toBeTrue();
		expect(built.wrap).toBeFalse();
		expect(built.packages[0]!.rojoProjectPath).toContain("default.project.json");
		expect(built.placeFile).toContain("place.rbxl");
	});

	it("should write a bootstrap that drives ExecuteRunModeAsync over a result socket", async () => {
		expect.assertions(5);

		resetVol();

		let bootstrap = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			bootstrap = fs.readFileSync(
				request.args[request.args.indexOf("--runScriptFile") + 1]!,
				"utf8",
			);
		});
		const backend = makeBackend(launch);

		await backend.runTestsAsync({ jobs: [job("alpha", { testNamePattern: "alpha-pattern" })] });

		expect(bootstrap).toContain("ExecuteRunModeAsync");
		expect(bootstrap).toContain("alpha-pattern");
		expect(bootstrap).toContain("CreateWebStreamClient");
		expect(bootstrap).toContain("ws://localhost:");
		// The bootstrap is an executable wire-protocol artifact. Its digest
		// complements the readable assertions without duplicating the script.

		const stableBootstrap = bootstrap
			.replaceAll(
				/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu,
				"<request-id>",
			)
			.replaceAll(/ws:\/\/localhost:\d+/gu, "ws://localhost:<port>");

		expect(stableBootstrap).toMatchSnapshot();
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

		await backend.runTestsAsync({ jobs: [job("alpha", { testNamePattern: "x]=]y" })] });

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

		await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should surface a version-mismatch error when the plugin echoes a different protocolVersion", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({ protocolVersion: 2 });

		await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should name the release the answering plugin came from", async () => {
		// Several copies can be installed at once, and each answers with its
		// own release: a protocol number alone would not say which to remove.
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({ pluginVersion: "0.3.18", protocolVersion: 5 });

		await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(
			/plugin from jest-roblox 0\.3\.18 reported v5/,
		);
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

		const { rawResults } = await backend.runTestsAsync(singleJob);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain(bigName);
	});

	it("should surface a whole-run plugin error (success:false) as its message", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({
			rawJestOutput: JSON.stringify({ err: "plugin produced no result", success: false }),
		});

		await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(/plugin produced no result/);
	});

	it("should ignore non-result frames and resolve on the matching result", async () => {
		// The server can see engine/plugin chatter and stray frames; only a
		// well-formed `results` frame for THIS requestId resolves the run.
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
		}).runTestsAsync(singleJob);

		expect(rawResults).toHaveLength(1);
	});

	it("should reject with a timeout when no result frame arrives", async () => {
		expect.assertions(2);

		resetVol();
		useResultDeadlineTimers();

		// A Studio that never sends a result drives the timeout path.
		const process = makeFakeProcess();
		let outputFile = "";
		const backend = new StudioCliBackend({
			buildPlaceAsync: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: (request) => {
				outputFile = readOutputFile(request.args);
				return process;
			},
			timeout: 40,
		});

		const settled = backend.runTestsAsync(singleJob).catch((err: unknown) => err);
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toBe(
			[
				"studio-cli: Studio run timed out after 40ms and was terminated.",
				`  Studio log: ${path.normalize(outputFile)}`,
			].join("\n"),
		);
		// The run kills Studio on the way out even on the timeout path.
		expect(process.kill).toHaveBeenCalledOnce();
	});

	it("should quote Studio's own log when no result frame arrives", async () => {
		expect.assertions(1);

		resetVol();
		useResultDeadlineTimers();

		// Studio's stdio is discarded, so `--outputFile` is the only thing left
		// to say what the run was doing when it stopped answering.
		let outputFile = "";
		const backend = new StudioCliBackend({
			buildPlaceAsync: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: (request) => {
				outputFile = readOutputFile(request.args);
				vol.writeFileSync(
					outputFile,
					[
						"discarded oldest line",
						"  ",
						...Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`),
						"x".repeat(300),
						"x".repeat(301),
						"final line",
					].join("\r\n"),
				);
				return makeFakeProcess();
			},
			timeout: 40,
		});

		const settled = backend.runTestsAsync(singleJob).catch((err: unknown) => err);
		await vi.runAllTimersAsync();
		const caught: unknown = await settled;

		assert(caught instanceof Error);

		expect(caught.message).toBe(
			[
				"studio-cli: Studio run timed out after 40ms and was terminated.",
				`  Studio log: ${path.normalize(outputFile)}`,
				"  Last lines Studio logged:",
				...Array.from({ length: 12 }, (_, index) => `    line ${String(index + 1)}`),
				`    ${"x".repeat(300)}`,
				`    ${"x".repeat(300)}…`,
				"    final line",
			].join("\n"),
		);
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
			}).runTestsAsync(singleJob),
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
			}).runTestsAsync(singleJob),
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

		await backend.runTestsAsync(singleJob);

		expect(captured!.studioPath).toBe("C:/Studio/RobloxStudioBeta.exe");
		expect(captured!.args).toStrictEqual(
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

		let wasHeadedRequested: boolean | undefined;
		const { launch } = replyWith({}, (request) => {
			wasHeadedRequested = request.headed;
		});

		await makeBackend(launch, { headed: true }).runTestsAsync(singleJob);

		expect(wasHeadedRequested).toBeTrue();
	});

	it("should default headed to false in the launch request", async () => {
		expect.assertions(1);

		resetVol();

		let wasHeadedRequested: boolean | undefined;
		const { launch } = replyWith({}, (request) => {
			wasHeadedRequested = request.headed;
		});

		await makeBackend(launch).runTestsAsync(singleJob);

		expect(wasHeadedRequested).toBeFalse();
	});

	it("should pass the studioPath override to the discover seam", async () => {
		expect.assertions(1);

		resetVol();

		const discover = vi.fn<(override: string | undefined) => string>(
			() => "C:/Studio/RobloxStudioBeta.exe",
		);
		const backend = new StudioCliBackend({
			buildPlaceAsync: fakeBuildPlace(),
			discover,
			launch: replyWith().launch,
			studioPath: "C:/override/RobloxStudioBeta.exe",
		});

		await backend.runTestsAsync(singleJob);

		expect(discover).toHaveBeenCalledWith("C:/override/RobloxStudioBeta.exe");
	});

	it("should reject --parallel > 1 with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		await expect(
			backendReplying().runTestsAsync({ jobs: [job("")], parallel: 2 }),
		).rejects.toThrow(/--parallel 2 is not supported/);
	});

	// Reachable without the CLI and config validators that screen these out.
	it("should reject a count no serial run can mean", async () => {
		expect.assertions(1);

		resetVol();

		await expect(
			backendReplying().runTestsAsync({ jobs: [job("")], parallel: 0 }),
		).rejects.toThrow(/--parallel 0 is not supported/);
	});

	it('should allow --parallel "auto", which asks for the count it needs', async () => {
		expect.assertions(1);

		resetVol();

		const { rawResults } = await backendReplying().runTestsAsync({
			jobs: [job("")],
			parallel: "auto",
		});

		expect(rawResults).toHaveLength(1);
	});

	it("should allow --parallel of 1", async () => {
		expect.assertions(1);

		resetVol();

		const { rawResults } = await backendReplying().runTestsAsync({
			jobs: [job("")],
			parallel: 1,
		});

		expect(rawResults).toHaveLength(1);
	});

	it("should reject work-stealing with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		await expect(
			backendReplying().runTestsAsync({ jobs: [job("")], workStealing: true }),
		).rejects.toThrow(/does not support work-stealing/);
	});

	it("should throw when given no jobs", async () => {
		expect.assertions(1);

		resetVol();

		await expect(backendReplying().runTestsAsync({ jobs: [] })).rejects.toThrow(
			"StudioCliBackend requires at least one job",
		);
	});

	it("should throw when the runtime returns a different entry count than jobs", async () => {
		expect.assertions(1);

		resetVol();

		const backend = backendReplying({
			entries: [{ jestOutput: successResult() }, { jestOutput: successResult() }],
		});

		await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(
			/returned 2 entries but request had 1 jobs/,
		);
	});

	it("should run a workspace config against the pre-built mega-place without building its own", async () => {
		expect.assertions(2);

		resetVol();

		const buildPlaceAsync =
			vi.fn<(options: BuildPlaceOptions) => Promise<BuildManifestArtifact>>(fakeBuildPlace());
		let localPlaceFile = "";
		const { launch } = replyWith({ entries: [{ jestOutput: successResult() }] }, (request) => {
			localPlaceFile = request.args[request.args.indexOf("--localPlaceFile") + 1]!;
		});
		const backend = new StudioCliBackend({
			buildPlaceAsync,
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch,
		});

		await backend.runTestsAsync({ jobs: [workspaceJob("@scope/a", "a")] });

		// The mega-place is already built by the workspace runner; studio-cli
		// must drive it, not build a second place from one package's rojo
		// project.
		expect(buildPlaceAsync).not.toHaveBeenCalled();
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

		await backend.runTestsAsync({
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

		const { rawResults } = await backend.runTestsAsync({
			jobs: [workspaceJob("@scope/a", "a"), workspaceJob("@scope/b", "b")],
		});

		expect(rawResults).toHaveLength(2);
		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([5, 7]);
	});

	it("should construct with default seams via createStudioCliBackend", async () => {
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
			buildPlaceAsync: fakeBuildPlace(),
			launch,
			studioPath: "C:/seeded/RobloxStudioBeta.exe",
		});

		await backend.runTestsAsync(singleJob);

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
		const backend = new StudioCliBackend({ buildPlaceAsync: fakeBuildPlace(), launch });

		await backend.runTestsAsync(singleJob);

		expect(launchedPath).toBe("C:/from-env/RobloxStudioBeta.exe");
	});

	describe("result server port", () => {
		// The default ephemeral-port path: a real `ws` server binds
		// asynchronously, so the backend waits for `listening` then reads the
		// assigned port. These drive that path with a fake server (the mock
		// reports its port up front and is returned without waiting).
		function pendingServer(boundPort: number | undefined): WebSocketServer {
			const server = new MockWebSocketServer({ port: 0 });
			// Report "not yet bound" until `listening` fires, then the assigned
			// port. State on an object so the lazy implementation re-reads it.
			const state = { listening: false };
			vi.spyOn(server, "address").mockImplementation(() => {
				if (boundPort !== undefined && state.listening) {
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
				buildPlaceAsync: fakeBuildPlace(),
				createServer: () => pendingServer(54_321),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch,
			});

			await backend.runTestsAsync(singleJob);

			expect(bootstrap).toContain("ws://localhost:54321");
		});

		it("should throw when the result server never reports a bound port", async () => {
			expect.assertions(1);

			resetVol();

			const backend = new StudioCliBackend({
				buildPlaceAsync: fakeBuildPlace(),
				createServer: () => pendingServer(undefined),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch: replyWith().launch,
			});

			await expect(backend.runTestsAsync(singleJob)).rejects.toThrow(/failed to bind a port/);
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

			const buildPlaceAsync =
				vi.fn<(options: BuildPlaceOptions) => Promise<BuildManifestArtifact>>(
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
				buildPlaceAsync,
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch,
			});

			await backend.runTestsAsync({ jobs: [coverageJob()] });

			// Exact path (not just `toContain`) so a rootDir/CWD resolution
			// drift is caught, and the clean place is provably never built.
			expect(localPlaceFile).toBe(
				normalizeWindowsPath(path.resolve("/repo", ".jest-roblox/coverage/game.rbxl")),
			);
			expect(buildPlaceAsync).not.toHaveBeenCalled();
		});

		it("should carry the runtime coverage data through to the rawResult entry", async () => {
			expect.assertions(1);

			resetVol();

			const coverageData = { "ReplicatedStorage/mod": { f: {}, s: { "1": 1 } } };
			const jestOutput = successResult({ runner: { coverage: coverageData } });
			const backend = backendReplying({ entries: [{ jestOutput }] });

			const { rawResults } = await backend.runTestsAsync({ jobs: [coverageJob()] });

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

			await makeBackend(launch).runTestsAsync(singleJob);

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

			await makeBackend(launch, { gracefulShutdownTimeout: 9999 }).runTestsAsync(singleJob);

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

			await expect(makeBackend(launch).runTestsAsync(singleJob)).rejects.toThrow(
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

		function stubSpawn() {
			const child = new FakeChild();
			let capturedArgs: Array<string> = [];
			let capturedFile = "";
			let capturedOptions: { stdio?: string; windowsHide?: boolean } = {};
			vi.mocked(spawn).mockImplementation(
				fromAny(
					(
						file: string,
						args: Array<string>,
						options: { stdio?: string; windowsHide?: boolean },
					) => {
						capturedFile = file;
						capturedOptions = options;
						capturedArgs = args;
						return child;
					},
				),
			);
			return {
				args: () => capturedArgs,
				child,
				request: () => ({ file: capturedFile, options: capturedOptions }),
			};
		}

		function backendWithDefaultLaunch(
			extra: Partial<ConstructorParameters<typeof StudioCliBackend>[0]> = {},
		): StudioCliBackend {
			return new StudioCliBackend({
				buildPlaceAsync: fakeBuildPlace(),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				...extra,
			});
		}

		// The `<place>.lock` the real spawnStudio clears pre-launch and the
		// graceful watch polls for release.
		const lockPath = `${path.join(path.resolve("/repo"), ".jest-roblox", "studio-cli", "place.rbxl")}.lock`;

		// Drive the result frame back over the server once the backend is
		// listening (the real spawnStudio does not reply on its own).
		async function replyOverServerAsync(
			args: () => Array<string>,
			previous: InstanceType<typeof MockWebSocketServer> | undefined,
		): Promise<void> {
			const server = await settledServerAsync(previous);
			const socket = new MockWebSocket();
			server.emit("connection", socket);
			socket.emit("message", Buffer.from(resultFrame(readRequestId(args()), {})));
		}

		/** Waits out the place build, so the spawn stub has been called. */
		async function settledSpawnAsync(): Promise<void> {
			const before = vi.mocked(spawn).mock.calls.length;
			for (let turn = 0; turn < SERVER_TURNS; turn += 1) {
				if (vi.mocked(spawn).mock.calls.length > before) {
					return;
				}

				await Promise.resolve();
			}

			throw new Error("the backend never spawned Studio");
		}

		/**
		 * The result server this run creates. Drained rather than awaited once:
		 * the place build in front of it is asynchronous, so the number of
		 * microtask turns before the server exists is an implementation detail.
		 * Compared against the server standing when the run began, because the
		 * mock's instance list outlives one test.
		 */
		async function settledServerAsync(
			previous: InstanceType<typeof MockWebSocketServer> | undefined,
		): Promise<InstanceType<typeof MockWebSocketServer>> {
			for (let turn = 0; turn < SERVER_TURNS; turn += 1) {
				const server = getLastCreatedServer();
				if (server !== undefined && server !== previous) {
					return server;
				}

				await Promise.resolve();
			}

			throw new Error("the backend never created a result server");
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
			expect.assertions(3);

			resetVol();
			useLockPollTimers();

			const { args, request } = stubSpawn();
			const previousServer = getLastCreatedServer();
			const promise = backendWithDefaultLaunch().runTestsAsync(singleJob);
			await replyOverServerAsync(args, previousServer);
			const { rawResults } = await promise;

			expect(rawResults).toHaveLength(1);
			expect(args()).toContain("RunScript");
			expect(request()).toStrictEqual({
				file: "C:/Studio/RobloxStudioBeta.exe",
				options: { stdio: "ignore", windowsHide: true },
			});
		});

		it("should leave the Studio window visible in headed mode", async () => {
			expect.assertions(1);

			resetVol();
			useLockPollTimers();

			const { args, request } = stubSpawn();
			const previousServer = getLastCreatedServer();
			const promise = backendWithDefaultLaunch({ headed: true }).runTestsAsync(singleJob);
			await replyOverServerAsync(args, previousServer);
			await promise;

			expect(request().options.windowsHide).toBeFalse();
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
			const previousServer = getLastCreatedServer();
			const promise = backendWithDefaultLaunch().runTestsAsync(singleJob);
			await replyOverServerAsync(args, previousServer);
			await promise;

			expect(fs.existsSync(lockPath)).toBeFalse();
		});

		it("should reject when Studio fails to spawn", async () => {
			expect.assertions(1);

			resetVol();

			const { child } = stubSpawn();
			const promise = backendWithDefaultLaunch().runTestsAsync(singleJob);
			await settledSpawnAsync();
			child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

			await expect(promise).rejects.toThrow(/spawn ENOENT/);
		});

		it("should kill Studio and reject when no result arrives before the timeout", async () => {
			expect.assertions(2);

			resetVol();
			useResultDeadlineTimers();

			const { child } = stubSpawn();

			const settled = backendWithDefaultLaunch({ timeout: 40 })
				.runTestsAsync(singleJob)
				.catch((err: unknown) => err);
			await vi.runAllTimersAsync();
			const caught: unknown = await settled;

			assert(caught instanceof Error);

			expect(caught.message).toMatch(/timed out after 40ms and was terminated/);
			expect(child.kill).toHaveBeenCalledOnce();
		});

		describe("graceful kill on lock release", () => {
			it("should kill the instant Studio releases the place lock", async () => {
				expect.assertions(2);

				resetVol();
				useLockPollTimers();

				const { args, child } = stubSpawn();
				const previousServer = getLastCreatedServer();
				const promise = backendWithDefaultLaunch().runTestsAsync(singleJob);
				await replyOverServerAsync(args, previousServer);
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
				const previousServer = getLastCreatedServer();
				const promise = backendWithDefaultLaunch({
					gracefulShutdownTimeout: 5000,
				}).runTestsAsync(singleJob);
				await replyOverServerAsync(args, previousServer);
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
