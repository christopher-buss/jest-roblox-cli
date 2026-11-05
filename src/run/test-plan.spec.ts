import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSeams } from "./seams.ts";
import type { TestPlan, TestPlanInput } from "./test-plan.ts";
import { bindTestPlanToPlace, buildTestPlan } from "./test-plan.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		placeFile: "/test/game.rbxl",
		rootDir: "/test",
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeProject(overrides: Partial<ResolvedProjectConfig> = {}): ResolvedProjectConfig {
	return fromAny({
		config: makeConfig(),
		displayName: "main",
		exclude: [],
		include: ["src/**/*.spec.ts"],
		projects: ["ReplicatedStorage.src"],
		rojoMounts: [],
		testMatch: ["**/*.spec"],
		...overrides,
	});
}

function makeSeams(): RunSeams {
	return createRunSeams({ tsconfigReader: vi.fn<RunSeams["tsconfigReader"]>(() => null) });
}

function makeVolume(files: ReadonlyArray<string>): FileSystem {
	const { fileSystem, volume } = createMemoryFileSystem();
	for (const file of files) {
		volume.mkdirSync(path.posix.dirname(file), { recursive: true });
		volume.writeFileSync(file, "return {}");
	}

	return fileSystem;
}

function plan(input: Partial<TestPlanInput> & { fileSystem: FileSystem }): TestPlan {
	return buildTestPlan({
		cliFiles: undefined,
		cliTypecheck: {},
		projects: [makeProject()],
		rootConfig: makeConfig(),
		seams: makeSeams(),
		timing: clockTimingCollector(),
		...input,
	});
}

describe(buildTestPlan, () => {
	it("should fail an empty run with exit code 2", () => {
		expect.assertions(1);

		const result = plan({ fileSystem: makeVolume([]) });

		expect(result).toStrictEqual({
			emptiness: {
				validationExitCode: 2,
				validationMessage: "No test files found in any project\n",
			},
			jobs: [],
			matchedRuntimeFiles: [],
			typeTestEntries: [],
		});
	});

	it("should pass an empty run under passWithNoTests", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume([]),
			rootConfig: makeConfig({ passWithNoTests: true }),
		});

		expect(result.emptiness).toStrictEqual({});
	});

	it("should plan one job per project with runtime files", () => {
		expect.assertions(3);

		const result = plan({
			fileSystem: makeVolume(["/test/src/a.spec.ts"]),
			projects: [makeProject({ displayColor: "blue" })],
		});

		expect(result.emptiness).toBeUndefined();
		expect(result.matchedRuntimeFiles).toStrictEqual(["src/a.spec.ts"]);
		expect(result.jobs).toMatchObject([
			{ displayColor: "blue", displayName: "main", runtimeFiles: ["src/a.spec.ts"] },
		]);
	});

	it("should inject a config only into mounts without a user-authored one", () => {
		expect.assertions(1);

		const fileSystem = makeVolume(["/test/src/a.spec.ts", "/test/user/jest.config.luau"]);
		const project = makeProject({
			rojoMounts: fromAny([
				{ dataModelPath: "ReplicatedStorage.src", fsPath: "src" },
				{ dataModelPath: "ReplicatedStorage.user", fsPath: "user" },
			]),
		});

		const result = plan({ fileSystem, projects: [project] });

		expect(result.jobs[0]!.runtimeInjectionPaths).toStrictEqual(["ReplicatedStorage.src"]);
	});

	it("should apply the project exclude to discovered files", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume(["/test/src/a.spec.ts", "/test/src/b.spec.ts"]),
			projects: [makeProject({ exclude: ["src/b.spec.ts"] })],
		});

		expect(result.matchedRuntimeFiles).toStrictEqual(["src/a.spec.ts"]);
	});

	it("should keep positional files past the project exclude", () => {
		expect.assertions(1);

		const result = plan({
			cliFiles: ["src/b.spec.ts"],
			fileSystem: makeVolume(["/test/src/b.spec.ts"]),
			projects: [makeProject({ exclude: ["src/b.spec.ts"] })],
		});

		expect(result.matchedRuntimeFiles).toStrictEqual([path.resolve("/test", "src/b.spec.ts")]);
	});

	it("should prefer a project's own file subset over the cli files", () => {
		expect.assertions(1);

		const result = plan({
			cliFiles: ["src/a.spec.ts", "src/b.spec.ts"],
			filesByProject: new Map([["main", ["src/b.spec.ts"]]]),
			fileSystem: makeVolume(["/test/src/a.spec.ts", "/test/src/b.spec.ts"]),
		});

		expect(result.matchedRuntimeFiles).toStrictEqual([path.resolve("/test", "src/b.spec.ts")]);
	});

	it("should plan type tests from the derived include when typecheck is on", () => {
		expect.assertions(2);

		const result = plan({
			cliTypecheck: { enabled: true, only: true, tsconfig: "tsconfig.spec.json" },
			fileSystem: makeVolume(["/test/src/a.spec.ts", "/test/src/a.spec-d.ts"]),
		});

		expect(result.jobs).toStrictEqual([]);
		expect(result.typeTestEntries).toStrictEqual([
			{ cwd: "/test", files: ["src/a.spec-d.ts"], tsconfig: "tsconfig.spec.json" },
		]);
	});

	it("should honor the typecheck include and exclude", () => {
		expect.assertions(1);

		const result = plan({
			cliTypecheck: { enabled: true },
			fileSystem: makeVolume(["/test/types/a.spec-d.ts", "/test/types/b.spec-d.ts"]),
			projects: [
				makeProject({
					typecheck: {
						exclude: ["types/b.spec-d.ts"],
						include: ["types/**/*.spec-d.ts"],
					},
				}),
			],
		});

		expect(result.typeTestEntries[0]!.files).toStrictEqual(["types/a.spec-d.ts"]);
	});

	it("should keep positional type tests past the typecheck exclude", () => {
		expect.assertions(1);

		const result = plan({
			cliFiles: ["types/b.spec-d.ts"],
			cliTypecheck: { enabled: true },
			fileSystem: makeVolume(["/test/types/b.spec-d.ts"]),
			projects: [makeProject({ typecheck: { exclude: ["types/b.spec-d.ts"] } })],
		});

		expect(result.typeTestEntries[0]!.files).toStrictEqual([
			path.resolve("/test", "types/b.spec-d.ts"),
		]);
	});
});

describe(bindTestPlanToPlace, () => {
	it("should aim every job at the given place and leave the rest alone", () => {
		expect.assertions(2);

		const built = plan({ fileSystem: makeVolume(["/test/src/a.spec.ts"]) });

		const bound = bindTestPlanToPlace(built, "/test/coverage.rbxl");

		expect(bound.jobs[0]!.config.placeFile).toBe("/test/coverage.rbxl");
		expect(bound).toStrictEqual({
			...built,
			jobs: [
				{
					...built.jobs[0]!,
					config: { ...built.jobs[0]!.config, placeFile: "/test/coverage.rbxl" },
				},
			],
		});
	});
});
