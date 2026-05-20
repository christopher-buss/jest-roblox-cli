import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import type { Backend } from "../backends/interface.ts";
import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import { narrowConfigByFiles } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { generateProjectStubs, syncStubsToShadowDirectory } from "../config/stubs.ts";
import { deriveCoverageFromIncludes } from "../coverage/derive-coverage-from.ts";
import { mergeRawCoverage } from "../coverage/merge-raw-coverage.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import { runProjects } from "../executor.ts";
import { combineSourceMappers, type SourceMapper } from "../source-mapper/index.ts";
import { runTypecheck } from "../typecheck/runner.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { buildWithRojo } from "../utils/rojo-builder.ts";
import { classifyTestFiles, discoverTestFiles, resolveSetupFilePaths } from "./discovery.ts";
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

	const rojoTree = loadRojoTree(rootConfig);

	const allProjects = await resolveAllProjects(
		rawProjects,
		rootConfig,
		rojoTree,
		rootConfig.rootDir,
	);

	for (const project of allProjects) {
		resolveSetupFilePaths(project.config);
	}

	const { filesByProject, projects } = selectProjects(
		allProjects,
		cli.project,
		cli.files,
		rootConfig.rootDir,
	);

	generateProjectStubs(projects, rootConfig.rootDir);

	if (!rootConfig.collectCoverage) {
		const rojoProjectPath = path.resolve(
			rootConfig.rootDir,
			rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
		);
		const placeFilePath = path.resolve(rootConfig.rootDir, rootConfig.placeFile);
		buildWithRojo(rojoProjectPath, placeFilePath);
	}

	const { effectiveConfig, preCoverageMs } = prepareMultiProjectCoverage(rootConfig, projects);
	const backend = await resolveBackend(cli, effectiveConfig);
	const parallel = effectiveParallelForBackend(effectiveConfig.parallel, backend);

	const { allTypeTestFiles, pendingJobs } = collectPendingJobs({
		cliFiles: cli.files,
		effectivePlaceFile: effectiveConfig.placeFile,
		filesByProject,
		projects,
		rootConfig,
	});

	const projectResults = await runJobs(backend, pendingJobs, parallel);

	const uniqueTypeTestFiles = [...new Set(allTypeTestFiles)];
	const typecheckResult =
		uniqueTypeTestFiles.length > 0
			? runTypecheck({
					files: uniqueTypeTestFiles,
					rootDir: rootConfig.rootDir,
					tsconfig: rootConfig.typecheckTsconfig,
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

		const projConfig: ResolvedConfig = narrowConfigByFiles(
			{ ...discoveryConfig, testMatch: project.testMatch },
			projectCliFiles ?? [],
		);

		allTypeTestFiles.push(...typeTestFiles);

		if (runtimeFiles.length === 0) {
			continue;
		}

		pendingJobs.push({
			config: projConfig,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeFiles,
		});
	}

	return { allTypeTestFiles, pendingJobs };
}

async function runJobs(
	backend: Backend,
	pendingJobs: Array<PendingJob>,
	parallel: ParallelOption,
): Promise<Array<ProjectResult>> {
	if (pendingJobs.length === 0) {
		await backend.close?.();
		return [];
	}

	let runResult;
	try {
		runResult = await runProjects({
			backend,
			deferFormatting: true,
			parallel,
			projects: pendingJobs.map((pending) => {
				return {
					config: pending.config,
					displayColor: pending.displayColor,
					displayName: pending.displayName,
					testFiles: pending.runtimeFiles,
				};
			}),
			startTime: Date.now(),
			version: VERSION,
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
): { effectiveConfig: ResolvedConfig; preCoverageMs: number } {
	if (!rootConfig.collectCoverage) {
		return { effectiveConfig: rootConfig, preCoverageMs: 0 };
	}

	const start = Date.now();
	const { placeFile } = prepareCoverage(rootConfig, (shadowDirectory) => {
		return syncStubsToShadowDirectory(projects, rootConfig.rootDir, shadowDirectory);
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
