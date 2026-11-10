import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem, type MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { makeExecuteResult, makeJestResult } from "#test/mocks/spec-results.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type {
	OutputSettings,
	ProjectResult,
	UnitTypecheckResult,
} from "../results/run-result-types.ts";
import type { GameOutputEntry } from "../protocol/game-output.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { writeRunSinksAsync } from "./sinks.ts";

const OUTPUT_DIRECTORY = path.join("/workspace", ".jest-roblox", "output");
const GAME_OUTPUT_ENTRY: GameOutputEntry = { message: "hi", messageType: 0, timestamp: 0 };
const RAW_GAME_OUTPUT = JSON.stringify([GAME_OUTPUT_ENTRY]);
const PER_UNIT_GAME_OUTPUT = path.join(OUTPUT_DIRECTORY, "@halcyon-foo--client.game-output.log");

function makeSettings(overrides: Partial<OutputSettings> = {}): OutputSettings {
	return {
		collectCoverage: false,
		color: false,
		formatters: ["default"],
		perUnitGameOutput: false,
		perUnitOutputFile: false,
		rootDir: "/workspace",
		showLuau: true,
		silent: false,
		verbose: false,
		...overrides,
	};
}

function makeProject(
	gameOutput: string | undefined = RAW_GAME_OUTPUT,
	result: JestResult = makeJestResult(),
): ProjectResult {
	return {
		displayName: "@halcyon/foo › client",
		result: makeExecuteResult({ gameOutput, result }),
		unit: { pkg: "@halcyon/foo", project: "client" },
	};
}

function readSink(volume: MemoryVolume, filePath: string): string {
	return String(volume.readFileSync(path.resolve(filePath), "utf8"));
}

async function writeAsync({
	mergedResult: givenMergedResult,
	projectResults = [makeProject()],
	settings,
	typecheckResult,
	typecheckUnits = [],
}: {
	mergedResult?: JestResult;
	projectResults?: Array<ProjectResult>;
	settings: OutputSettings;
	typecheckResult?: JestResult;
	typecheckUnits?: Array<UnitTypecheckResult>;
}): Promise<{ consoleError: ReturnType<typeof vi.spyOn>; volume: MemoryVolume }> {
	const { fileSystem, volume } = createMemoryFileSystem();
	const consoleError = vi.spyOn(console, "error").mockReturnValue(undefined);
	const runtime: ExecuteResult | undefined = projectResults[0]?.result;
	const mergedResult =
		givenMergedResult ?? typecheckResult ?? runtime?.result ?? makeJestResult();

	await writeRunSinksAsync({
		fileSystem,
		mergedResult,
		projectResults,
		runtime,
		settings,
		typecheckUnits,
	});

	return { consoleError, volume };
}

describe(writeRunSinksAsync, () => {
	it("should write the run's merged result to the result file", async () => {
		expect.assertions(1);

		const { volume } = await writeAsync({
			mergedResult: makeJestResult({ numFailedTests: 1, numPassedTests: 3, success: false }),
			projectResults: [makeProject(undefined, makeJestResult({ numPassedTests: 2 }))],
			settings: makeSettings({ outputFile: "/workspace/all.json" }),
			typecheckResult: makeJestResult({ numFailedTests: 1, success: false }),
		});

		expect(JSON.parse(readSink(volume, "/workspace/all.json"))).toMatchObject({
			numFailedTests: 1,
			numPassedTests: 3,
			success: false,
		});
	});

	it("should write nothing when no sink is configured", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeAsync({ settings: makeSettings() });

		expect(volume.toJSON()).toStrictEqual({});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should write one sanitized result file per pair, merging its Type Tests", async () => {
		expect.assertions(2);

		const typecheck = makeJestResult({ numPassedTests: 5 });
		const { volume } = await writeAsync({
			projectResults: [makeProject(undefined, makeJestResult({ numPassedTests: 2 }))],
			settings: makeSettings({ perUnitOutputFile: true }),
			typecheckUnits: [
				{ pkg: "@halcyon/foo", project: "client", result: typecheck },
				{ pkg: "@halcyon/foo", project: "types", result: typecheck },
			],
		});

		expect(
			JSON.parse(readSink(volume, path.join(OUTPUT_DIRECTORY, "@halcyon-foo--client.jest-output.log"))),
		).toMatchObject({ numPassedTests: 7 });
		expect(
			readSink(volume, path.join(OUTPUT_DIRECTORY, "@halcyon-foo--types.jest-output.log")),
		).toBe(JSON.stringify(typecheck, null, 2));
	});

	it("should write per-pair result files for a run with no runtime job", async () => {
		expect.assertions(1);

		const typecheck = makeJestResult();
		const { volume } = await writeAsync({
			projectResults: [],
			settings: makeSettings({ perUnitGameOutput: true, perUnitOutputFile: true }),
			typecheckResult: typecheck,
			typecheckUnits: [{ pkg: "@scope/foo bar", project: "types", result: typecheck }],
		});

		expect(Object.keys(volume.toJSON()).map((file) => path.basename(file))).toStrictEqual([
			"@scope-foo-bar--types.jest-output.log",
		]);
	});

	it("should group the aggregated Game Output by package and project", async () => {
		expect.assertions(3);

		const { consoleError, volume } = await writeAsync({
			settings: makeSettings({ gameOutput: "/workspace/game.json", perUnitGameOutput: true }),
		});

		expect(JSON.parse(readSink(volume, "/workspace/game.json"))).toStrictEqual([
			{ entries: [GAME_OUTPUT_ENTRY], package: "@halcyon/foo", project: "client" },
		]);
		expect(JSON.parse(readSink(volume, PER_UNIT_GAME_OUTPUT))).toStrictEqual([
			GAME_OUTPUT_ENTRY,
		]);
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			"Game output (1 entries) written to /workspace/game.json",
		);
	});

	it("should group a project without a package under its display name", async () => {
		expect.assertions(1);

		const { volume } = await writeAsync({
			projectResults: [
				{ displayName: "client", result: makeExecuteResult({ gameOutput: RAW_GAME_OUTPUT }) },
			],
			settings: makeSettings({ gameOutput: "/workspace/game.json", perUnitGameOutput: true }),
		});

		expect(JSON.parse(readSink(volume, "/workspace/game.json"))).toStrictEqual([
			{ entries: [GAME_OUTPUT_ENTRY], project: "client" },
		]);
	});

	it("should write one batch group when the runner captured output for the batch", async () => {
		expect.assertions(1);

		const batched = makeProject();
		batched.result.gameOutputScope = "batch";
		const { volume } = await writeAsync({
			projectResults: [batched, makeProject("[]")],
			settings: makeSettings({ gameOutput: "/workspace/game.json" }),
		});

		expect(JSON.parse(readSink(volume, "/workspace/game.json"))).toStrictEqual([
			{ entries: [GAME_OUTPUT_ENTRY], project: "(all projects)", scope: "batch" },
		]);
	});

	it("should not name the aggregate on a failed run, whose report names it", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeAsync({
			projectResults: [makeProject(RAW_GAME_OUTPUT, makeJestResult({ success: false }))],
			settings: makeSettings({ gameOutput: "/workspace/game.json" }),
		});

		expect(volume.existsSync(path.resolve("/workspace/game.json"))).toBeTrue();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should name the per-package files for an agent, failed run included", async () => {
		expect.assertions(1);

		const { consoleError } = await writeAsync({
			projectResults: [makeProject(RAW_GAME_OUTPUT, makeJestResult({ success: false }))],
			settings: makeSettings({
				formatters: ["agent"],
				gameOutput: "/workspace/game.json",
				perUnitGameOutput: true,
			}),
		});

		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Game output (1 entries) written to ${PER_UNIT_GAME_OUTPUT}`,
		);
	});

	it("should name the per-package files when they are the only Game Output", async () => {
		expect.assertions(1);

		const { consoleError } = await writeAsync({
			projectResults: [makeProject(), makeProject("[]")],
			settings: makeSettings({ perUnitGameOutput: true }),
		});

		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Game output (1 entries) written to ${PER_UNIT_GAME_OUTPUT}`,
		);
	});

	it("should skip per-package Game Output for a project without a package", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeAsync({
			projectResults: [
				{ displayName: "client", result: makeExecuteResult({ gameOutput: RAW_GAME_OUTPUT }) },
			],
			settings: makeSettings({ perUnitGameOutput: true, perUnitOutputFile: true }),
		});

		expect(Object.keys(volume.toJSON()).filter((file) => file.endsWith(".log"))).toBeEmpty();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should not announce an empty aggregate", async () => {
		expect.assertions(1);

		const { consoleError } = await writeAsync({
			projectResults: [makeProject("[]")],
			settings: makeSettings({ gameOutput: "/workspace/game.json" }),
		});

		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should name no Game Output under silent", async () => {
		expect.assertions(2);

		const { consoleError, volume } = await writeAsync({
			settings: makeSettings({
				gameOutput: "/workspace/game.json",
				perUnitGameOutput: true,
				silent: true,
			}),
		});

		expect(volume.existsSync(path.resolve("/workspace/game.json"))).toBeTrue();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("should write no Game Output for a run with no runtime job", async () => {
		expect.assertions(1);

		const { volume } = await writeAsync({
			projectResults: [],
			settings: makeSettings({ gameOutput: "/workspace/game.json" }),
			typecheckResult: makeJestResult(),
		});

		expect(volume.existsSync(path.resolve("/workspace/game.json"))).toBeFalse();
	});

	it("should append the GitHub Actions job summary", async () => {
		expect.assertions(1);

		onTestFinished(() => {
			delete process.env["GITHUB_STEP_SUMMARY"];
		});
		process.env["GITHUB_STEP_SUMMARY"] = "/summary.md";

		const { volume } = await writeAsync({
			settings: makeSettings({ formatters: ["github-actions"] }),
		});

		expect(readSink(volume, "/summary.md")).not.toBe("");
	});
});
