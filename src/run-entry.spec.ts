import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "#test/mocks/run-constants.ts";
import { createRunSeams } from "#test/mocks/run-seams.ts";
import { makeExecuteResult } from "#test/mocks/spec-results.ts";
import type { CliOptions, ResolvedConfig } from "./config/resolved-config.ts";
import type { RunProgress } from "./progress/run-progress.ts";
import type { RunJestRobloxOptions } from "./run-entry.ts";
import { runJestRobloxAsync, runMergedJestRobloxAsync } from "./run-entry.ts";
import type { RunSeams } from "./run/seams.ts";

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		passWithNoTests: true,
		rootDir: "/test",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makeCli(overrides: Partial<CliOptions> = {}): CliOptions {
	return { typecheckOnly: true, ...overrides };
}

function hermetic(): Pick<RunJestRobloxOptions, "fileSystem" | "seams"> {
	return { fileSystem: createMemoryFileSystem().fileSystem, seams: createRunSeams() };
}

function declaredRun(resolveAllProjects: RunSeams["resolveAllProjects"]) {
	return {
		fileSystem: createMemoryFileSystem({
			"/test/default.project.json": JSON.stringify({
				name: "test",
				tree: { $className: "DataModel" },
			}),
		}).fileSystem,
		seams: createRunSeams({ resolveAllProjects }),
	};
}

const DECLARED: ResolvedConfig["projects"] = [
	{ test: { displayName: "a", include: ["a.spec.ts"] } },
];

function resolvedVerbose(resolveAllProjects: RunSeams["resolveAllProjects"]): boolean | undefined {
	return vi.mocked(resolveAllProjects).mock.calls[0]![0].rootConfig.verbose;
}

function captureTimingReport(): MockInstance<typeof process.stderr.write> {
	vi.stubEnv("TIMING", "1");
	return vi.spyOn(process.stderr, "write").mockReturnValue(true);
}

function timingLines(stderr: MockInstance<typeof process.stderr.write>): Array<string> {
	return stderr.mock.calls.map(([line]) => String(line));
}

describe(runJestRobloxAsync, () => {
	it("should run a workspace invocation through the real workspace layout", async () => {
		expect.assertions(1);

		const result = await runJestRobloxAsync({
			cli: makeCli({ affectedSince: "main", packages: "a", workspace: true }),
			config: makeConfig(),
			...hermetic(),
		});

		expect(result).toMatchObject({
			validationExitCode: 2,
			validationMessage: "Error: --packages and --affected-since are mutually exclusive.\n",
		});
	});

	it("should refuse a workspace-only flag without --workspace before any run", async () => {
		expect.assertions(2);

		const seams = createRunSeams();

		const result = await runJestRobloxAsync({
			cli: makeCli({ bail: true }),
			config: makeConfig(),
			fileSystem: createMemoryFileSystem().fileSystem,
			seams,
		});

		expect(result).toMatchObject({
			projectResults: [],
			validationExitCode: 2,
			validationMessage: "Error: --bail requires --workspace.\n",
		});
		expect(seams.resolveAllProjects).not.toHaveBeenCalled();
	});

	it("should run a config without projects through the project layout", async () => {
		expect.assertions(1);

		const result = await runJestRobloxAsync({
			cli: makeCli(),
			config: makeConfig(),
			progress: NOOP_PROGRESS,
			...hermetic(),
		});

		expect(result.projectResults).toBeEmpty();
	});

	it("should announce the run's stages on the given progress", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/test/default.project.json": JSON.stringify({
				name: "test",
				tree: {
					$className: "DataModel",
					ReplicatedStorage: { client: { $path: "out/client" } },
				},
			}),
			"/test/out/client/a.spec.luau": "",
			"/test/src/client/a.spec.ts": "",
		});
		const begin = vi.fn<RunProgress["begin"]>(() => () => {});
		const seams = createRunSeams({
			childProcess: fromAny({
				execFile: writingRojoExec({ bytes: "RBXL", fileSystem: volume }),
			}),

			openBackend: () => {
				return {
					kind: "open-cloud",
					runTestsAsync: async () => fromAny({}),
				};
			},
			runProjects: async (input) => {
				return {
					backendTiming: { executionMs: 0, uploadMs: 0 },
					results: input.jobs.map((_job, jobIndex) => {
						return { ...makeExecuteResult(), jobIndex };
					}),
				};
			},
			tsconfigReader: () => null,
		});

		await runJestRobloxAsync({
			cli: {},
			config: makeConfig({ luauRoots: ["out/client"], rojoProject: "default.project.json" }),
			fileSystem,
			progress: { ...NOOP_PROGRESS, begin },
			seams,
		});

		expect(begin).toHaveBeenCalledWith("build");
	});

	it("should apply the CLI options over the config it gets", async () => {
		expect.assertions(1);

		const resolveAllProjects = vi.fn<RunSeams["resolveAllProjects"]>().mockResolvedValue([]);

		await runJestRobloxAsync({
			cli: makeCli({ verbose: true }),
			config: makeConfig({ projects: DECLARED, verbose: false }),
			...declaredRun(resolveAllProjects),
		});

		expect(resolvedVerbose(resolveAllProjects)).toBeTrue();
	});

	it("should flush timing when the run rejects", async () => {
		expect.assertions(2);

		const error = new Error("projects failed");
		const stderr = captureTimingReport();

		await expect(
			runJestRobloxAsync({
				cli: makeCli({ typecheckOnly: false }),
				config: makeConfig({ projects: DECLARED }),
				...declaredRun(vi.fn<RunSeams["resolveAllProjects"]>().mockRejectedValue(error)),
			}),
		).rejects.toBe(error);
		expect(timingLines(stderr).at(-1)).toContain("TOTAL (host)");
	});

	it("should not emit a build manifest for a non-coverage run", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		await runJestRobloxAsync({
			cli: makeCli(),
			config: makeConfig(),
			fileSystem,
			seams: createRunSeams(),
		});

		expect(volume.existsSync(COVERAGE_BUILD_MANIFEST_PATH)).toBeFalse();
	});
});

describe(runMergedJestRobloxAsync, () => {
	it("should run on the config as given", async () => {
		expect.assertions(1);

		const resolveAllProjects = vi.fn<RunSeams["resolveAllProjects"]>().mockResolvedValue([]);

		await runMergedJestRobloxAsync({
			cli: makeCli({ verbose: true }),
			config: makeConfig({ projects: DECLARED, verbose: false }),
			...declaredRun(resolveAllProjects),
		});

		expect(resolvedVerbose(resolveAllProjects)).toBeFalse();
	});
});
