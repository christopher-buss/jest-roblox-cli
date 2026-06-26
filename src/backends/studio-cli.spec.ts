import { fromAny, fromExact } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { BuildPlaceOptions } from "../staging/place-builder.ts";
import type { JestResult } from "../types/jest-result.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { createStudioCliBackend, StudioCliBackend } from "./studio-cli.ts";
import type { StudioCliLauncher, StudioCliLaunchRequest } from "./studio-cli.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("node:child_process"));

// Must match RESULT_DELIMITER in studio-cli.ts — the wire contract the bootstrap
// (Luau producer) and readStudioResult (host parser) share. Hard-coded so a
// silent drift in the delimiter fails this test.
const DELIMITER = "@@JEST_ROBLOX_STUDIO_CLI_RESULT@@";

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

// The run-mode runner echoes protocolVersion in its result; the host requires
// it to match. Default to the current protocol so happy-path helpers round-trip;
// version-handshake tests build their own wrapper inline to omit/mismatch it.
function wrappedLog(wrapper: {
	gameOutput?: string;
	jestOutput: string;
	protocolVersion?: number;
}): string {
	const echoed = { protocolVersion: 3, ...wrapper };
	return `Roblox Studio engine line\n${DELIMITER}${JSON.stringify(echoed)}${DELIMITER}\nbye\n`;
}

function launchWriting(content: string): StudioCliLauncher {
	return async (request) => {
		fs.writeFileSync(request.outputFile, content);
	};
}

function fakeBuildPlace(): (options: BuildPlaceOptions) => { hash: string; path: string } {
	return (options) => ({ hash: "hash", path: options.placeFile });
}

function singleOk(): StudioCliLauncher {
	return launchWriting(
		wrappedLog({ gameOutput: "[]", jestOutput: envelope([{ jestOutput: successResult() }]) }),
	);
}

function makeBackend(launch: StudioCliLauncher): StudioCliBackend {
	return new StudioCliBackend({
		buildPlace: fakeBuildPlace(),
		discover: () => "C:/Studio/RobloxStudioBeta.exe",
		launch,
	});
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

		const backend = makeBackend(singleOk());
		const { rawResults, timing } = await backend.runTests(singleJob);

		expect(rawResults).toHaveLength(1);
		expect(rawResults[0]!.entry.jestOutput).toContain('"numPassedTests":2');
		expect(timing.executionMs).toBeGreaterThanOrEqual(0);
	});

	it("should return one rawResult per job, in submitted order, for a multi-project run", async () => {
		expect.assertions(2);

		resetVol();

		const backend = makeBackend(
			launchWriting(
				wrappedLog({
					jestOutput: envelope([
						{ elapsedMs: 11, jestOutput: successResult() },
						{ elapsedMs: 22, jestOutput: successResult() },
					]),
				}),
			),
		);

		const { rawResults } = await backend.runTests({ jobs: [job("alpha"), job("beta")] });

		expect(rawResults).toHaveLength(2);
		expect(rawResults.map((raw) => raw.entry.elapsedMs)).toStrictEqual([11, 22]);
	});

	it("should surface the wrapper gameOutput as the fallback on each rawResult", async () => {
		expect.assertions(1);

		resetVol();

		const fallback = JSON.stringify([{ message: "hi", messageType: 0, timestamp: 0 }]);
		const backend = makeBackend(
			launchWriting(
				wrappedLog({
					gameOutput: fallback,
					jestOutput: envelope([{ jestOutput: successResult() }]),
				}),
			),
		);

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
			launch: singleOk(),
		});

		await backend.runTests(singleJob);

		const built = buildPlace.mock.calls[0]![0];

		expect(built.loadStringEnabled).toBeTrue();
		expect(built.wrap).toBeFalse();
		expect(built.packages[0]!.rojoProjectPath).toContain("default.project.json");
		expect(built.placeFile).toContain("place.rbxl");
	});

	it("should write a bootstrap that drives ExecuteRunModeAsync with the per-job configs", async () => {
		expect.assertions(3);

		resetVol();

		let bootstrap = "";
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: async (request) => {
				const index = request.args.indexOf("--runScriptFile");
				bootstrap = fs.readFileSync(request.args[index + 1]!, "utf8");
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
			},
		});

		await backend.runTests({ jobs: [job("alpha", { testNamePattern: "alpha-pattern" })] });

		expect(bootstrap).toContain("ExecuteRunModeAsync");
		expect(bootstrap).toContain("alpha-pattern");
		expect(bootstrap).toContain(DELIMITER);
	});

	it("should escape a config value containing the Luau long-string terminator", async () => {
		// A config string with `]=]` would close a level-1 `[=[ … ]=]` long
		// string early and produce invalid Luau (a silent no-result run). The
		// bracket level must escalate so the payload round-trips intact.
		expect.assertions(2);

		resetVol();

		let bootstrap = "";
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: async (request) => {
				const index = request.args.indexOf("--runScriptFile");
				bootstrap = fs.readFileSync(request.args[index + 1]!, "utf8");
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
			},
		});

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

		const backend = makeBackend(
			launchWriting(
				`${DELIMITER}${JSON.stringify({
					gameOutput: "[]",
					jestOutput: envelope([{ jestOutput: successResult() }]),
				})}${DELIMITER}`,
			),
		);

		await expect(backend.runTests(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should surface a version-mismatch error when the plugin echoes a different protocolVersion", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(
			launchWriting(
				`${DELIMITER}${JSON.stringify({
					gameOutput: "[]",
					jestOutput: envelope([{ jestOutput: successResult() }]),
					protocolVersion: 2,
				})}${DELIMITER}`,
			),
		);

		await expect(backend.runTests(singleJob)).rejects.toThrow(/protocol.*mismatch/i);
	});

	it("should throw a clear error when the result wrapper JSON is truncated", async () => {
		// Studio crashing mid-write leaves truncated JSON between the delimiters;
		// the raw JSON.parse SyntaxError must surface as the backend's clean
		// diagnostic, not a bare "Unexpected end of JSON input".
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(launchWriting(`${DELIMITER}{"jestOutput":${DELIMITER}`));

		await expect(backend.runTests(singleJob)).rejects.toThrow(/malformed result envelope/);
	});

	it("should launch Studio with the RunScript task argument set", async () => {
		expect.assertions(2);

		resetVol();

		let captured: Pick<StudioCliLaunchRequest, "args" | "studioPath"> | undefined;
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: async (request) => {
				captured = { args: request.args, studioPath: request.studioPath };
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
			},
		});

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

	it("should pass the studioPath override to the discover seam", async () => {
		expect.assertions(1);

		resetVol();

		const discover = vi.fn<(override: string | undefined) => string>(
			() => "C:/Studio/RobloxStudioBeta.exe",
		);
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover,
			launch: singleOk(),
			studioPath: "C:/override/RobloxStudioBeta.exe",
		});

		await backend.runTests(singleJob);

		expect(discover).toHaveBeenCalledWith("C:/override/RobloxStudioBeta.exe");
	});

	it("should reject --parallel > 1 with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(singleOk());

		await expect(backend.runTests({ jobs: [job("")], parallel: 2 })).rejects.toThrow(
			/--parallel > 1 is not supported/,
		);
	});

	it("should allow --parallel of 1", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(singleOk());
		const { rawResults } = await backend.runTests({ jobs: [job("")], parallel: 1 });

		expect(rawResults).toHaveLength(1);
	});

	it("should reject work-stealing with a clear message", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(singleOk());

		await expect(backend.runTests({ jobs: [job("")], workStealing: true })).rejects.toThrow(
			/does not support work-stealing/,
		);
	});

	it("should throw when given no jobs", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(singleOk());

		await expect(backend.runTests({ jobs: [] })).rejects.toThrow(
			"StudioCliBackend requires at least one job",
		);
	});

	it("should throw a clear error when the output log has no result envelope", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(launchWriting("engine log with no delimiter\n"));

		await expect(backend.runTests(singleJob)).rejects.toThrow(/no test result was produced/);
	});

	it("should throw a clear error when no output file is written at all", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(async () => {
			// Launch returns without writing the output file.
		});

		await expect(backend.runTests(singleJob)).rejects.toThrow(/no test result was produced/);
	});

	it("should throw a clear error when only an opening delimiter is present", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(launchWriting(`prefix\n${DELIMITER}{"jestOutput":"x"}\n`));

		await expect(backend.runTests(singleJob)).rejects.toThrow(/no test result was produced/);
	});

	it("should throw on a malformed result wrapper", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(
			launchWriting(`${DELIMITER}${JSON.stringify({ notJest: 1 })}${DELIMITER}`),
		);

		await expect(backend.runTests(singleJob)).rejects.toThrow(/malformed result envelope/);
	});

	it("should surface a whole-run plugin error (success:false) as its message", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(
			launchWriting(
				wrappedLog({
					jestOutput: JSON.stringify({
						err: "plugin produced no result",
						success: false,
					}),
				}),
			),
		);

		await expect(backend.runTests(singleJob)).rejects.toThrow(/plugin produced no result/);
	});

	it("should throw when the runtime returns a different entry count than jobs", async () => {
		expect.assertions(1);

		resetVol();

		const backend = makeBackend(
			launchWriting(
				wrappedLog({
					jestOutput: envelope([
						{ jestOutput: successResult() },
						{ jestOutput: successResult() },
					]),
				}),
			),
		);

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
		const backend = new StudioCliBackend({
			buildPlace,
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: async (request) => {
				const index = request.args.indexOf("--localPlaceFile");
				localPlaceFile = request.args[index + 1]!;
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({
						jestOutput: envelope([{ jestOutput: successResult() }]),
					}),
				);
			},
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
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			discover: () => "C:/Studio/RobloxStudioBeta.exe",
			launch: async (request) => {
				const index = request.args.indexOf("--runScriptFile");
				bootstrap = fs.readFileSync(request.args[index + 1]!, "utf8");
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({
						jestOutput: envelope([
							{ jestOutput: successResult() },
							{ jestOutput: successResult() },
						]),
					}),
				);
			},
		});

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

		const backend = makeBackend(
			launchWriting(
				wrappedLog({
					jestOutput: envelope([
						{ elapsedMs: 5, jestOutput: successResult() },
						{ elapsedMs: 7, jestOutput: successResult() },
					]),
				}),
			),
		);

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
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			launch: async (request) => {
				launchedPath = request.studioPath;
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
			},
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
		const backend = new StudioCliBackend({
			buildPlace: fakeBuildPlace(),
			launch: async (request) => {
				launchedPath = request.studioPath;
				fs.writeFileSync(
					request.outputFile,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
			},
		});

		await backend.runTests(singleJob);

		expect(launchedPath).toBe("C:/from-env/RobloxStudioBeta.exe");
	});

	describe("coverage", () => {
		function coverageJob(): ProjectJob {
			return job("", {
				collectCoverage: true,
				placeFile: ".jest-roblox/coverage/game.rbxl",
			});
		}

		function argumentValue(args: Array<string>, flag: string): string {
			return args[args.indexOf(flag) + 1]!;
		}

		it("should open the coverage-instrumented place instead of building a Clean Place", async () => {
			expect.assertions(2);

			resetVol();

			const buildPlace =
				vi.fn<(options: BuildPlaceOptions) => { hash: string; path: string }>(
					fakeBuildPlace(),
				);
			let localPlaceFile = "";
			const backend = new StudioCliBackend({
				buildPlace,
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
				launch: async (request) => {
					localPlaceFile = argumentValue(request.args, "--localPlaceFile");
					fs.writeFileSync(
						request.outputFile,
						wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
					);
				},
			});

			await backend.runTests({ jobs: [coverageJob()] });

			// Exact path (not just `toContain`) so a rootDir/CWD resolution drift
			// is caught, and the clean place is provably never built.
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
			const backend = makeBackend(
				launchWriting(wrappedLog({ jestOutput: envelope([{ jestOutput }]) })),
			);

			const { rawResults } = await backend.runTests({ jobs: [coverageJob()] });

			// The coverage-bearing jestOutput rides through verbatim, so the
			// downstream parser/mapper produce the report exactly as on
			// open-cloud.
			expect(rawResults[0]!.entry.jestOutput).toBe(jestOutput);
		});
	});

	describe("default launcher (spawnStudio)", () => {
		function stubExecFile(
			impl: (
				file: string,
				args: Array<string>,
				callback: (
					error: (Error & { code?: number | string; killed?: boolean }) | null,
				) => void,
			) => void,
		): void {
			vi.mocked(execFile).mockImplementation(((
				file: string,
				args: Array<string>,
				_options: unknown,
				callback: (
					error: (Error & { code?: number | string; killed?: boolean }) | null,
				) => void,
			) => {
				impl(file, args, callback);
				return fromAny({});
			}) as unknown as typeof execFile);
		}

		function backendWithDefaultLaunch(): StudioCliBackend {
			return new StudioCliBackend({
				buildPlace: fakeBuildPlace(),
				discover: () => "C:/Studio/RobloxStudioBeta.exe",
			});
		}

		it("should spawn Studio and parse the result it writes", async () => {
			expect.assertions(2);

			resetVol();

			let spawnedFile = "";
			stubExecFile((file, args, callback) => {
				spawnedFile = file;
				const index = args.indexOf("--outputFile");
				fs.writeFileSync(
					args[index + 1]!,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
				callback(null);
			});

			const { rawResults } = await backendWithDefaultLaunch().runTests(singleJob);

			expect(spawnedFile).toBe("C:/Studio/RobloxStudioBeta.exe");
			expect(rawResults).toHaveLength(1);
		});

		it("should reject with a timeout message when Studio is killed", async () => {
			expect.assertions(1);

			resetVol();

			stubExecFile((_file, _args, callback) => {
				callback(Object.assign(new Error("killed"), { killed: true }));
			});

			await expect(backendWithDefaultLaunch().runTests(singleJob)).rejects.toThrow(
				/timed out after .* and was terminated/,
			);
		});

		it("should reject when Studio fails to spawn", async () => {
			expect.assertions(1);

			resetVol();

			stubExecFile((_file, _args, callback) => {
				callback(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			});

			await expect(backendWithDefaultLaunch().runTests(singleJob)).rejects.toThrow(
				/spawn ENOENT/,
			);
		});

		it("should still read the result on a non-zero Studio exit code", async () => {
			expect.assertions(1);

			resetVol();

			stubExecFile((_file, args, callback) => {
				const index = args.indexOf("--outputFile");
				fs.writeFileSync(
					args[index + 1]!,
					wrappedLog({ jestOutput: envelope([{ jestOutput: successResult() }]) }),
				);
				callback(Object.assign(new Error("exit 1"), { code: 1 }));
			});

			const { rawResults } = await backendWithDefaultLaunch().runTests(singleJob);

			expect(rawResults).toHaveLength(1);
		});
	});
});
