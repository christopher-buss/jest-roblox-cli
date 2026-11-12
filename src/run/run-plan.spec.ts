import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunDiscovery, TestPlan } from "./run-plan.ts";
import { buildTestPlan } from "./run-plan.ts";
import type { RunSeams } from "./seams.ts";

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

function relatedRun(files: Array<string>): NonNullable<RunDiscovery["partialRun"]> {
	const root = path.resolve("/test");
	return {
		files: files.map((file) => path.resolve(root, file)),
		kind: "related",
		scope: {
			forceRerunTriggers: [],
			projectRoot: posixPath(root),
			rojoRoots: [posixPath(root)],
			workspaceRoot: posixPath(root),
		},
	};
}

function plan(input: Partial<RunDiscovery> & { fileSystem: FileSystem }): TestPlan {
	return buildTestPlan({
		cliFiles: undefined,
		cliTypecheck: {},
		partialRun: undefined,
		progress: NOOP_PROGRESS,
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

		expect({ ...result, projects: [], tsconfigCache: undefined }).toStrictEqual({
			affected: undefined,
			emptiness: {
				validationExitCode: 2,
				validationMessage: "No test files found in any project\n",
			},
			jobs: [],
			matchedRuntimeFiles: [],
			projects: [],
			tsconfigCache: undefined,
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

	it("should pass an empty related run with a notice", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume(["/test/src/util.luau"]),
			partialRun: relatedRun(["src/util.luau"]),
			rootConfig: makeConfig({ passWithNoTests: true }),
		});

		expect(result.emptiness).toStrictEqual({
			validationMessage: "No test files reach the related files, exiting with code 0\n",
		});
	});

	it("should pass an empty --changed run with a notice that names the ref", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume(["/test/src/util.luau"]),
			partialRun: { ...relatedRun(["src/util.luau"]), kind: "changed", since: "main" },
			rootConfig: makeConfig({ passWithNoTests: true }),
		});

		expect(result.emptiness).toStrictEqual({
			validationMessage:
				"No test files reach the files changed since main, exiting with code 0\n",
		});
	});

	it("should keep exit code 2 for an empty --changed run without passWithNoTests", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume(["/test/src/util.luau"]),
			partialRun: { ...relatedRun(["src/util.luau"]), kind: "changed", since: "main" },
			rootConfig: makeConfig({ passWithNoTests: false }),
		});

		expect(result.emptiness).toMatchObject({ validationExitCode: 2 });
	});

	it("should have the runner report timings when the run is timed", () => {
		expect.assertions(1);

		const result = plan({
			fileSystem: makeVolume(["/test/src/a.spec.ts"]),
			timing: { ...clockTimingCollector(), enabled: true },
		});

		expect(result.jobs[0]!.argv.runnerTiming).toBeTrue();
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
			{
				displayColor: "blue",
				displayName: "main",
				testFiles: ["src/a.spec.ts"],
			},
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
			{
				cwd: "/test",
				files: [path.resolve("/test", "src/a.spec-d.ts")],
				tsconfig: "tsconfig.spec.json",
			},
		]);
	});

	it("should keep only the tests that reach a related file, in a profiled phase", () => {
		expect.assertions(4);

		const { fileSystem } = createMemoryFileSystem({
			[path.resolve("/test/src/a.spec-d.luau")]: 'return require("./util")',
			[path.resolve("/test/src/a.spec.luau")]: 'return require("./util")',
			[path.resolve("/test/src/b.spec-d.luau")]: "return nil",
			[path.resolve("/test/src/b.spec.luau")]: "return nil",
			[path.resolve("/test/src/util.luau")]: "return {}",
		});
		const timing = clockTimingCollector();

		const result = plan({
			cliTypecheck: { enabled: true },
			fileSystem,
			partialRun: relatedRun(["src/util.luau"]),
			projects: [makeProject({ include: ["src/**/*.spec.luau"] })],
			timing,
		});

		expect(result.matchedRuntimeFiles).toStrictEqual(["src/a.spec.luau"]);
		expect(result.jobs[0]!.config.testPathPattern).toBe("(a\\.spec)");
		expect(result.typeTestEntries[0]!.files).toStrictEqual([
			path.resolve("/test/src/a.spec-d.luau"),
		]);
		expect(result.affected).toStrictEqual({
			affected: 1,
			cause: { files: ["src/util.luau"], kind: "related" },
			total: 2,
		});
	});
});
