import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ExecuteResult } from "../executor.ts";
import { usesAgentFormatter } from "../formatters/utils.ts";
import { mergeProjectResults, mergeResults, writeResultFileAsync } from "../output.ts";
import type { JestResult } from "../types/jest-result.ts";
import {
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "../utils/game-output.ts";
import { writeTypecheckOnlySinksAsync, writeWorkspaceSinksAsync } from "./output-sinks.ts";
import type { PendingEntry, TypeTestProject } from "./test-selection.ts";

vi.mock(import("../formatters/utils"));
vi.mock(import("../output"));
vi.mock(import("../utils/game-output"));

const mocks = {
	buildGroupedGameOutput: vi.mocked(buildGroupedGameOutput),
	countGroupedEntries: vi.mocked(countGroupedEntries),
	formatGameOutputNotice: vi.mocked(formatGameOutputNotice),
	mergeProjectResults: vi.mocked(mergeProjectResults),
	mergeResults: vi.mocked(mergeResults),
	parseGameOutput: vi.mocked(parseGameOutput),
	usesAgentFormatter: vi.mocked(usesAgentFormatter),
	writeGameOutput: vi.mocked(writeGameOutput),
	writeGroupedGameOutput: vi.mocked(writeGroupedGameOutput),
	writeResultFileAsync: vi.mocked(writeResultFileAsync),
};
const collator = new Intl.Collator("en");

function makeJestResult(label: string): JestResult {
	return fromAny({ label, success: true });
}

function makeExecuteResult(result = makeJestResult("runtime")): ExecuteResult {
	return fromAny({ gameOutput: "raw-game-output", result });
}

function makePending(packageName = "@halcyon/foo", project = "client"): PendingEntry {
	return fromAny({ pkg: packageName, project: { displayName: project } });
}

function setupMocks(): void {
	vi.clearAllMocks();
	mocks.buildGroupedGameOutput.mockReturnValue([]);
	mocks.countGroupedEntries.mockReturnValue(0);
	mocks.formatGameOutputNotice.mockReturnValue("");
	mocks.mergeProjectResults.mockReturnValue(
		fromAny({ result: makeJestResult("merged-runtime") }),
	);
	mocks.mergeResults.mockImplementation(
		(typeResult, runtimeResult) => runtimeResult ?? typeResult!,
	);
	mocks.parseGameOutput.mockReturnValue([]);
	mocks.usesAgentFormatter.mockReturnValue(false);
	mocks.writeResultFileAsync.mockResolvedValue();
}

describe(writeWorkspaceSinksAsync, () => {
	it("should write a sanitized per-project result file with recursive directory creation", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		setupMocks();

		const result = makeJestResult("runtime");

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

		const directory = path.join("/workspace", ".jest-roblox", "output");

		const resultPath = path.join(directory, "@scope-foo-bar--unit-client.jest-output.log");

		expect(volume.statSync(directory).isDirectory()).toBeTrue();
		expect(volume.readFileSync(resultPath, "utf8")).toBe(JSON.stringify(result, null, 2));
	});

	it("should merge the runtime result only when an aggregate output path exists", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();

		const typecheckResult = makeJestResult("typecheck");
		const results = [makeExecuteResult()];

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results,
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

		expect(mocks.mergeProjectResults).toHaveBeenCalledExactlyOnceWith(results);
		expect(mocks.writeResultFileAsync).toHaveBeenCalledExactlyOnceWith(
			"/workspace/all.json",
			typecheckResult,
			makeJestResult("merged-runtime"),
			fileSystem,
		);
	});

	it("should avoid merging runtime results when no aggregate output path exists", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();

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

		expect(mocks.mergeProjectResults).not.toHaveBeenCalled();
		expect(mocks.writeResultFileAsync).toHaveBeenCalledExactlyOnceWith(
			undefined,
			undefined,
			undefined,
			fileSystem,
		);
	});

	it("should prefer the aggregate Game Output notice for human formatting", async () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();

		mocks.buildGroupedGameOutput.mockReturnValue(fromAny([{ entries: [{}] }]));
		mocks.countGroupedEntries.mockReturnValue(1);
		mocks.formatGameOutputNotice.mockImplementation((outputPath) => `notice:${outputPath}`);
		mocks.parseGameOutput.mockReturnValue(fromAny([{}]));
		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult()],
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

		expect(mocks.writeGroupedGameOutput).toHaveBeenCalledExactlyOnceWith(
			"/workspace/all-game.json",
			expect.any(Array),
			fileSystem,
		);
		expect(mocks.writeGameOutput).toHaveBeenCalledExactlyOnceWith(
			path.join(
				"/workspace",
				".jest-roblox",
				"output",
				"@halcyon-foo--client.game-output.log",
			),
			expect.any(Array),
			fileSystem,
		);
		expect(consoleError).toHaveBeenCalledExactlyOnceWith("notice:/workspace/all-game.json");
	});

	it("should prefer non-empty per-package notices for agent formatting", async () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();
		mocks.usesAgentFormatter.mockReturnValue(true);
		mocks.parseGameOutput.mockReturnValueOnce(fromAny([{}])).mockReturnValueOnce([]);
		mocks.formatGameOutputNotice
			.mockReturnValueOnce("")
			.mockReturnValueOnce("notice:1")
			.mockReturnValueOnce("");
		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending("@halcyon/foo"), makePending("@halcyon/bar")],
				results: [makeExecuteResult(), makeExecuteResult()],
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

		expect(mocks.formatGameOutputNotice).toHaveBeenCalledTimes(3);
		expect(consoleError).toHaveBeenCalledExactlyOnceWith("notice:1");
	});

	it("should announce per-package output when it is the only active sink", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();
		mocks.parseGameOutput.mockReturnValue(fromAny([{}]));
		mocks.formatGameOutputNotice.mockReturnValue("package notice");
		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult()],
				runOptions: { workspaceGameOutput: true, workspaceOutputFile: false },
				typecheckByPackage: new Map(),
				typecheckResult: undefined,
				typeTestProjects: [],
				workspaceRoot: "/workspace",
			}),
		);

		expect(consoleError).toHaveBeenCalledExactlyOnceWith("package notice");
	});

	it("should not announce an empty aggregate", async () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		setupMocks();
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

		setupMocks();

		mocks.formatGameOutputNotice.mockReturnValue("notice");
		const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);

		await writeWorkspaceSinksAsync(
			fromAny({
				fileSystem,
				pending: [makePending()],
				results: [makeExecuteResult()],
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

		setupMocks();

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

		setupMocks();

		await expect(
			writeWorkspaceSinksAsync(
				fromAny({
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
});

describe(writeTypecheckOnlySinksAsync, () => {
	it("should write one merged result for every type-test project when enabled", async () => {
		expect.assertions(4);

		const { fileSystem, volume } = createMemoryFileSystem();

		setupMocks();

		const typecheckResult = makeJestResult("typecheck");

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

		expect(mocks.writeResultFileAsync).toHaveBeenCalledExactlyOnceWith(
			"/workspace/all.json",
			typecheckResult,
			undefined,
			fileSystem,
		);
		expect(mocks.mergeResults.mock.calls).toStrictEqual([
			[typecheckResult, undefined],
			[typecheckResult, undefined],
		]);

		const outputDirectory = path.join("/workspace", ".jest-roblox", "output");

		expect(
			volume.readdirSync(outputDirectory).map(String).toSorted(collator.compare),
		).toStrictEqual([
			"@halcyon-foo--strict.jest-output.log",
			"@halcyon-foo--types.jest-output.log",
		]);
		expect(
			volume.readFileSync(
				path.join(outputDirectory, "@halcyon-foo--types.jest-output.log"),
				"utf8",
			),
		).toBe(JSON.stringify(typecheckResult, null, 2));
	});

	it("should skip per-project typecheck files when the workspace sink is disabled", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		setupMocks();

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

		expect(volume.existsSync(path.join("/workspace", ".jest-roblox", "output"))).toBeFalse();
	});
});
