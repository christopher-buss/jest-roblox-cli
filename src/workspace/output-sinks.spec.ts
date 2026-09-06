import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ExecuteResult } from "../executor/types.ts";
import type { GameOutputEntry } from "../types/game-output.ts";
import type { JestResult } from "../types/jest-result.ts";
import { writeTypecheckOnlySinksAsync, writeWorkspaceSinksAsync } from "./output-sinks.ts";
import type { PendingEntry, TypeTestProject } from "./test-selection.ts";

const collator = new Intl.Collator("en");
const OUTPUT_DIRECTORY = path.join("/workspace", ".jest-roblox", "output");
const GAME_OUTPUT_ENTRY: GameOutputEntry = { message: "hi", messageType: 0, timestamp: 0 };
const RAW_GAME_OUTPUT = JSON.stringify([GAME_OUTPUT_ENTRY]);

function makeJestResult(overrides: Partial<JestResult> = {}): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTodoTests: 0,
		numTotalTests: 1,
		startTime: 1000,
		success: true,
		testResults: [],
		...overrides,
	};
}

function makeExecuteResult(result = makeJestResult(), gameOutput?: string): ExecuteResult {
	return fromAny({ gameOutput, result });
}

function makePending(packageName = "@halcyon/foo", project = "client"): PendingEntry {
	return fromAny({ pkg: packageName, project: { displayName: project } });
}

// memfs keys a path as written, so on Windows "/workspace/x" and its resolved
// form are two different volume keys.
function readSink(
	volume: ReturnType<typeof createMemoryFileSystem>["volume"],
	file: string,
): string {
	return String(volume.readFileSync(path.resolve(file), "utf8"));
}

describe(writeWorkspaceSinksAsync, () => {
	it("should write a sanitized per-project result file with recursive directory creation", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const result = makeJestResult({ numPassedTests: 7, numTotalTests: 7 });

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending("@scope/foo / bar", "unit / client")],
				results: [makeExecuteResult(result)],
				runOptions: { workspaceGameOutput: false, workspaceOutputFile: true },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		const resultPath = path.join(
			OUTPUT_DIRECTORY,
			"@scope-foo-bar--unit-client.jest-output.log",
		);

		expect(volume.statSync(OUTPUT_DIRECTORY).isDirectory()).toBeTrue();
		expect(volume.readFileSync(resultPath, "utf8")).toBe(JSON.stringify(result, null, 2));
	});

	it("should merge the runtime result only when an aggregate output path exists", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		const typecheckResult = makeJestResult({ numPassedTests: 1, numTotalTests: 1 });
		const runtime = makeJestResult({ numPassedTests: 2, numTotalTests: 2 });

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult(runtime)],
				runOptions: {
					outputFile: "/workspace/all.json",
					workspaceGameOutput: false,
					workspaceOutputFile: false,
				},
				typecheckByPackage: new Map(),
				typecheckResult,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(JSON.parse(readSink(volume, "/workspace/all.json"))).toStrictEqual({
			numFailedTests: 0,
			numPassedTests: 3,
			numPendingTests: 0,
			numTodoTests: 0,
			numTotalTests: 3,
			startTime: 1000,
			success: true,
			testResults: [],
		});
	});

	it("should avoid merging runtime results when no aggregate output path exists", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [],
				results: [],
				runOptions: { workspaceGameOutput: false, workspaceOutputFile: false },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(volume.toJSON()).toStrictEqual({});
	});

	it("should prefer the aggregate Game Output notice for human formatting", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult(makeJestResult(), RAW_GAME_OUTPUT)],
				runOptions: {
					formatters: ["default"],
					gameOutput: "/workspace/all-game.json",
					workspaceGameOutput: true,
					workspaceOutputFile: false,
				},
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		const perPackagePath = path.join(OUTPUT_DIRECTORY, "@halcyon-foo--client.game-output.log");

		expect(JSON.parse(readSink(volume, "/workspace/all-game.json"))).toStrictEqual([
			{ entries: [GAME_OUTPUT_ENTRY], package: "@halcyon/foo", project: "client" },
		]);
		expect(JSON.parse(readSink(volume, perPackagePath))).toStrictEqual([GAME_OUTPUT_ENTRY]);
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			"Game output (1 entries) written to /workspace/all-game.json",
		);
	});

	it("should prefer non-empty per-package notices for agent formatting", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending("@halcyon/foo"), makePending("@halcyon/bar")],
				results: [
					makeExecuteResult(makeJestResult(), RAW_GAME_OUTPUT),
					makeExecuteResult(),
				],
				runOptions: {
					formatters: ["agent"],
					gameOutput: "/workspace/all-game.json",
					workspaceGameOutput: true,
					workspaceOutputFile: false,
				},
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(volume.existsSync(path.resolve("/workspace/all-game.json"))).toBeTrue();
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Game output (1 entries) written to ${path.join(OUTPUT_DIRECTORY, "@halcyon-foo--client.game-output.log")}`,
		);
	});

	it("should announce per-package output when it is the only active sink", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult(makeJestResult(), RAW_GAME_OUTPUT)],
				runOptions: { workspaceGameOutput: true, workspaceOutputFile: false },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Game output (1 entries) written to ${path.join(OUTPUT_DIRECTORY, "@halcyon-foo--client.game-output.log")}`,
		);
	});

	it("should not announce an empty aggregate", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult()],
				runOptions: {
					gameOutput: "/workspace/all-game.json",
					workspaceGameOutput: false,
					workspaceOutputFile: false,
				},
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should suppress every Game Output notice under silent mode", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult(makeJestResult(), RAW_GAME_OUTPUT)],
				runOptions: {
					gameOutput: "/workspace/all-game.json",
					silent: true,
					workspaceGameOutput: true,
					workspaceOutputFile: false,
				},
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should stay silent when no Game Output sink is configured", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult()],
				runOptions: { workspaceGameOutput: false, workspaceOutputFile: false },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should reject a workspace result without its matching pending entry", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		await expect(
			writeWorkspaceSinksAsync(
				fromAny({
					fileSystem,
					pending: [],
					results: [makeExecuteResult()],
					runOptions: {
						gameOutput: "/workspace/all-game.json",
						workspaceGameOutput: false,
						workspaceOutputFile: false,
					},
					typecheckByPackage: new Map(),
					typecheckResult: undefined,
					typeTestProjects: [],
					workspaceRoot: "/workspace",
				}),
			),
		).rejects.toThrow("Pending entry missing for workspace result");
	});

	it("should reach the real filesystem when no seam is handed in", async () => {
		expect.assertions(1);

		await expect(
			writeWorkspaceSinksAsync(
				fromAny({
					pending: [makePending()],
					results: [makeExecuteResult()],
					runOptions: { workspaceGameOutput: false, workspaceOutputFile: false },
					typecheckByPackage: new Map(),
					typecheckResult: undefined,
					typeTestProjects: [],
					workspaceRoot: "/workspace",
				}),
			),
		).resolves.toBeUndefined();
	});
});

describe(writeTypecheckOnlySinksAsync, () => {
	it("should write one merged result for every type-test project when enabled", async () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		const typecheckResult = makeJestResult({ numPassedTests: 4, numTotalTests: 4 });

		const projects: Array<TypeTestProject> = [
			{ pkg: "@halcyon/foo", project: "types" },
			{ pkg: "@halcyon/foo", project: "strict" },
		];

		await writeTypecheckOnlySinksAsync(
			fromAny({
				fileSystem,
				runOptions: { outputFile: "/workspace/all.json", workspaceOutputFile: true },
				typecheckByPackage: new Map([["@halcyon/foo", typecheckResult]]),
				typecheckResult,
				typeTestProjects: projects,
				workspaceRoot: "/workspace",
			}),
		);

		expect(readSink(volume, "/workspace/all.json")).toBe(
			JSON.stringify(typecheckResult, null, 2),
		);
		expect(
			volume.readdirSync(OUTPUT_DIRECTORY).map(String).toSorted(collator.compare),
		).toStrictEqual([
			"@halcyon-foo--strict.jest-output.log",
			"@halcyon-foo--types.jest-output.log",
		]);
		expect(
			volume.readFileSync(
				path.join(OUTPUT_DIRECTORY, "@halcyon-foo--types.jest-output.log"),
				"utf8",
			),
		).toBe(JSON.stringify(typecheckResult, null, 2));
	});

	it("should skip per-project typecheck files when the workspace sink is disabled", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		await writeTypecheckOnlySinksAsync(
			fromAny({
				fileSystem,
				runOptions: { workspaceOutputFile: false },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(volume.existsSync(OUTPUT_DIRECTORY)).toBeFalse();
	});
});
