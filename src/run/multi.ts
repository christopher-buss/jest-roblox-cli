import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import {
	cleanLeftoverStubs,
	generateProjectStubs,
	hasUserAuthoredConfig,
	STUB_FILENAME,
	syncStubsToShadowDirectory,
} from "../config/stubs.ts";
import { deriveCoverageFromIncludes } from "../coverage/derive-coverage-from.ts";
import { mergeRawCoverage } from "../coverage/merge-raw-coverage.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import { runProjects } from "../executor.ts";
import { combineSourceMappers, type SourceMapper } from "../source-mapper/index.ts";
import { type StubMount, synthesize } from "../staging/synthesizer.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { classifyTestFiles, discoverTestFiles, resolveAllSetupFilePaths } from "./discovery.ts";
import type { MultiProjectMerged, MultiRunResult, ProjectResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
const VERSION: string = packageJson.version;

export interface MultiRunOptions extends RunOptions {
	rawProjects: Array<ProjectEntry>;
}

type ParallelOption = "auto" | number | undefined;

interface PendingJob {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	runtimeFiles: Array<string>;
	// Mount paths the Studio runner should inject `jest.config` into; empty
	// when every mount already has a user-authored config on disk.
	runtimeInjectionPaths: Array<string>;
}

interface CollectPendingJobsArguments {
	cliFiles: Array<string> | undefined;
	effectivePlaceFile: string;
	/**
	 * Per-project subset of `cliFiles` when auto-pick filtered cli files to
	 * specific projects. When absent or missing for a given project, the full
	 * `cliFiles` array is used (back-compat for `--project` and no-positional
	 * flows).
	 */
	filesByProject?: ReadonlyMap<string, Array<string>>;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

interface SelectedProjects {
	filesByProject?: ReadonlyMap<string, Array<string>>;
	projects: Array<ResolvedProjectConfig>;
}

export async function runMultiProject(options: MultiRunOptions): Promise<MultiRunResult> {
	const { cli, config: rootConfig, rawProjects } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;

	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig));

	const allProjects = await timing.profileAsync("resolveAllProjects", async () => {
		return resolveAllProjects(rawProjects, rootConfig, rojoTree, rootConfig.rootDir);
	});

	timing.profile("resolveSetupFilePaths", () => {
		resolveAllSetupFilePaths(allProjects.map((project) => project.config));
	});

	const { filesByProject, projects } = timing.profile("selectProjects", () => {
		return selectProjects(allProjects, cli.project, cli.files, rootConfig.rootDir);
	});

	// Stubs land in `.jest-roblox/cache/` instead of the user's source
	// tree. Open-cloud builds the place from a synthesizer-produced
	// project that mounts those cache stubs via `$path` named-children;
	// studio skips the place build entirely and the plugin's Run Mode
	// runner materializes `jest.config` ModuleScripts in DataModel from
	// the JSON configs.
	const cacheRoot = path.resolve(rootConfig.rootDir, ".jest-roblox", "cache");

	// Pre-flight cleanup mirrors workspace behaviour: upgraders coming
	// from a pre-refactor version may have marker-bearing leftover stubs
	// in their source tree. The synthesizer's `assertNoSourceCollision`
	// and the plugin's runtime `FindFirstChild` check would both block
	// the run otherwise.
	const cleaned = timing.profile("cleanLeftoverStubs", () => {
		return cleanLeftoverStubs(projects, rootConfig.rootDir);
	});
	if (cleaned.length > 0) {
		process.stderr.write(
			`jest-roblox: cleaned ${String(cleaned.length)} leftover stub(s):\n${cleaned
				.map((stubPath) => `  ${stubPath}\n`)
				.join("")}`,
		);
	}

	timing.profile("generateProjectStubs", () => {
		generateProjectStubs(projects, rootConfig.rootDir, cacheRoot);
	});

	const { effectiveConfig, preCoverageMs } = timing.profile("prepareCoverage", () => {
		return prepareMultiProjectCoverage(rootConfig, projects, cacheRoot);
	});
	const backend = await timing.profileAsync("resolveBackend", async () => {
		return resolveBackend(cli, effectiveConfig);
	});
	const parallel = effectiveParallelForBackend(effectiveConfig.parallel, backend);

	if (!rootConfig.collectCoverage && backend.kind === "open-cloud") {
		timing.profile("buildOpenCloudPlace", () => {
			buildOpenCloudPlace(rootConfig, projects, cacheRoot);
		});
	}

	const { allTypeTestFiles, pendingJobs } = timing.profile("collectPendingJobs", () => {
		return collectPendingJobs({
			cliFiles: cli.files,
			effectivePlaceFile: effectiveConfig.placeFile,
			filesByProject,
			projects,
			rootConfig,
		});
	});

	const projectResults = await runJobs(backend, pendingJobs, parallel, timing);

	const uniqueTypeTestFiles = [...new Set(allTypeTestFiles)];
	const typecheckResult =
		uniqueTypeTestFiles.length > 0
			? timing.profile("runTypecheck", () => {
					return runTypecheck({
						files: uniqueTypeTestFiles,
						rootDir: rootConfig.rootDir,
						tsconfig: rootConfig.typecheckTsconfig,
					});
				})
			: undefined;

	if (projectResults.length === 0 && typecheckResult === undefined) {
		if (rootConfig.passWithNoTests) {
			return {
				merged: {},
				mode: "multi",
				preCoverageMs,
				projectResults: [],
			};
		}

		return {
			merged: {},
			mode: "multi",
			preCoverageMs,
			projectResults: [],
			validationExitCode: 2,
			validationMessage: "No test files found in any project\n",
		};
	}

	const collectCoverageFrom = rootConfig.collectCoverage
		? (rootConfig.collectCoverageFrom ?? deriveCoverageFromIncludes(projects))
		: rootConfig.collectCoverageFrom;

	return {
		collectCoverageFrom,
		merged: mergeForMultiResult(projectResults),
		mode: "multi",
		preCoverageMs,
		projectResults,
		typecheckResult,
	};
}

function buildOpenCloudPlace(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): void {
	const userRojoProjectPath = path.resolve(
		rootConfig.rootDir,
		rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
	);
	const placeFilePath = path.resolve(rootConfig.rootDir, rootConfig.placeFile);
	// Per-mount FS check decides whether to inject. A TS string-entry
	// may or may not have a compiled `.luau` at the mount yet —
	// trust the filesystem rather than the entry shape.
	const stubMounts: Array<StubMount> = [];
	for (const project of projects) {
		for (const mount of project.rojoMounts) {
			const sourceMount = path.resolve(rootConfig.rootDir, mount.fsPath);
			if (hasUserAuthoredConfig(sourceMount)) {
				continue;
			}

			stubMounts.push({
				absStubPath: path.resolve(cacheRoot, mount.fsPath, STUB_FILENAME),
				dataModelPath: mount.dataModelPath,
			});
		}
	}

	const synthProjectPath = path.resolve(cacheRoot, "synth.project.json");
	fs.mkdirSync(path.dirname(synthProjectPath), { recursive: true });
	fs.writeFileSync(
		synthProjectPath,
		synthesize({
			packages: [
				{
					name: "multi-project",
					packageDirectory: rootConfig.rootDir,
					rojoProjectPath: userRojoProjectPath,
					stubMounts,
				},
			],
			wrap: false,
		}),
		"utf8",
	);
	buildWithRojo(synthProjectPath, placeFilePath);
}

function collectPendingJobs(arguments_: CollectPendingJobsArguments): {
	allTypeTestFiles: Array<string>;
	pendingJobs: Array<PendingJob>;
} {
	const { cliFiles, effectivePlaceFile, filesByProject, projects, rootConfig } = arguments_;
	const pendingJobs: Array<PendingJob> = [];
	const allTypeTestFiles: Array<string> = [];

	for (const project of projects) {
		// When auto-pick produced a per-project file subset, only feed those
		// files into discovery / narrowing for this project. Otherwise (no
		// positional files, or explicit `--project`), fall back to the full
		// cli.files list.
		const projectCliFiles = filesByProject?.get(project.displayName) ?? cliFiles;

		const discoveryConfig: ResolvedConfig = {
			...project.config,
			placeFile: effectivePlaceFile,
			projects: project.projects,
			testMatch: project.include,
		};

		const discovery = discoverTestFiles(discoveryConfig, projectCliFiles);
		const { runtimeFiles, typeTestFiles } = classifyTestFiles(discovery.files, rootConfig);

		// Narrow by the per-project discovered files (not the raw positional/flag
		// input) so the Luau runner receives an Instance-namespace basename
		// pattern. A bare project run (no positionals, no `--testPathPattern`)
		// keeps `testPathPattern` undefined so Jest-on-Roblox runs all testMatch.
		const filterActive =
			(projectCliFiles?.length ?? 0) > 0 || discoveryConfig.testPathPattern !== undefined;
		const projConfig: ResolvedConfig = narrowForLuauRun(
			{ ...discoveryConfig, testMatch: project.testMatch },
			runtimeFiles,
			filterActive,
		);

		allTypeTestFiles.push(...typeTestFiles);

		if (runtimeFiles.length === 0) {
			continue;
		}

		// Same per-mount FS filter as the synthesizer's stubMounts loop:
		// drop mounts where a user-authored `jest.config.luau` already
		// exists. The runtime injector mustn't parent a duplicate
		// `jest.config` over a Rojo-synced user file.
		const runtimeInjectionPaths: Array<string> = [];
		for (const mount of project.rojoMounts) {
			const sourceMount = path.resolve(rootConfig.rootDir, mount.fsPath);
			if (hasUserAuthoredConfig(sourceMount)) {
				continue;
			}

			runtimeInjectionPaths.push(mount.dataModelPath);
		}

		pendingJobs.push({
			config: projConfig,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeFiles,
			runtimeInjectionPaths,
		});
	}

	return { allTypeTestFiles, pendingJobs };
}

async function runJobs(
	backend: Backend,
	pendingJobs: Array<PendingJob>,
	parallel: ParallelOption,
	timing: TimingCollector,
): Promise<Array<ProjectResult>> {
	if (pendingJobs.length === 0) {
		await backend.close?.();
		return [];
	}

	let runResult;
	try {
		runResult = await timing.profileAsync("runProjects", async () => {
			return runProjects({
				backend,
				deferFormatting: true,
				parallel,
				projects: pendingJobs.map((pending) => {
					return {
						config: pending.config,
						displayColor: pending.displayColor,
						displayName: pending.displayName,
						runtimeInjectionPaths: pending.runtimeInjectionPaths,
						testFiles: pending.runtimeFiles,
					};
				}),
				startTime: Date.now(),
				timing,
				version: VERSION,
			});
		});
	} finally {
		await backend.close?.();
	}

	return runResult.results.map((executeResult, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
		const pending = pendingJobs[index]!;
		return {
			displayColor: pending.displayColor,
			displayName: pending.displayName,
			result: executeResult,
		};
	});
}

function loadRojoTree(config: ResolvedConfig): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fs.readFileSync(rojoPath, "utf8");
	const parsed = JSON.parse(content);
	const validated = rojoProjectSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Rojo project: ${validated.summary}`);
	}

	return resolveNestedProjects(validated.tree, path.dirname(rojoPath));
}

function prepareMultiProjectCoverage(
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): { effectiveConfig: ResolvedConfig; preCoverageMs: number } {
	if (!rootConfig.collectCoverage) {
		return { effectiveConfig: rootConfig, preCoverageMs: 0 };
	}

	const start = Date.now();
	const { placeFile } = prepareCoverage(rootConfig, (shadowDirectory) => {
		// Mirror cache stubs into the shadow tree. The source tree is
		// clean post-refactor (stubs land in `cacheRoot`, not `rootDir`),
		// so without this the coverage place would build without any
		// `jest.config` ModuleScripts.
		return syncStubsToShadowDirectory(projects, cacheRoot, shadowDirectory);
	});
	return {
		effectiveConfig: { ...rootConfig, placeFile },
		preCoverageMs: Date.now() - start,
	};
}

function effectiveParallelForBackend(
	parallel: ParallelOption,
	backend: { kind: string },
): ParallelOption {
	return backend.kind === "open-cloud" ? parallel : undefined;
}

function mergeForMultiResult(projectResults: Array<ProjectResult>): MultiProjectMerged {
	if (projectResults.length === 0) {
		return {};
	}

	let mergedCoverage: RawCoverageData | undefined;
	const mappers: Array<SourceMapper> = [];

	for (const { result } of projectResults) {
		if (result.coverageData !== undefined) {
			mergedCoverage = mergeRawCoverage(mergedCoverage, result.coverageData);
		}

		if (result.sourceMapper !== undefined) {
			mappers.push(result.sourceMapper);
		}
	}

	const merged: MultiProjectMerged = {};
	if (mergedCoverage !== undefined) {
		merged.coverageData = mergedCoverage;
	}

	if (mappers.length > 0) {
		merged.sourceMapper = combineSourceMappers(mappers);
	}

	return merged;
}

function filterProjectsByName(
	projects: Array<ResolvedProjectConfig>,
	names: Array<string>,
): Array<ResolvedProjectConfig> {
	const available = new Set(projects.map((project) => project.displayName));
	const unknown = names.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	const nameSet = new Set(names);
	return projects.filter((project) => nameSet.has(project.displayName));
}

function selectProjects(
	allProjects: Array<ResolvedProjectConfig>,
	projectNames: Array<string> | undefined,
	cliFiles: Array<string> | undefined,
	rootDirectory: string,
): SelectedProjects {
	if (projectNames !== undefined) {
		return { projects: filterProjectsByName(allProjects, projectNames) };
	}

	if (cliFiles !== undefined && cliFiles.length > 0) {
		const matches = filterProjectsByFiles(allProjects, cliFiles, rootDirectory);
		return {
			filesByProject: new Map(
				matches.map((match) => [match.project.displayName, match.matchingFiles]),
			),
			projects: matches.map((match) => match.project),
		};
	}

	return { projects: allProjects };
}
