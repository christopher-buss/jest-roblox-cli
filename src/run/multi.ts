import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackend } from "../backends/auto.ts";
import type { Backend, ProjectJob } from "../backends/interface.ts";
import { narrowConfigByFiles } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { generateProjectStubs, syncStubsToShadowDirectory } from "../config/stubs.ts";
import { deriveCoverageFromIncludes } from "../coverage/derive-coverage-from.ts";
import { mergeRawCoverage } from "../coverage/merge-raw-coverage.ts";
import { prepareCoverage } from "../coverage/prepare.ts";
import type { RawCoverageData } from "../coverage/types.ts";
import { buildProjectJob, executeBackend, processProjectResult } from "../executor.ts";
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
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
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

	const projects =
		cli.project !== undefined ? filterProjectsByName(allProjects, cli.project) : allProjects;

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
		projects,
		rootConfig,
	});

	const jobs = pendingJobs.map((pending) => {
		return buildProjectJob({
			config: pending.config,
			displayColor: pending.displayColor,
			displayName: pending.displayName,
			testFiles: pending.runtimeFiles,
		});
	});

	const projectResults = await runJobs(backend, jobs, pendingJobs, parallel);

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
	const { cliFiles, effectivePlaceFile, projects, rootConfig } = arguments_;
	const pendingJobs: Array<PendingJob> = [];
	const allTypeTestFiles: Array<string> = [];

	for (const project of projects) {
		const discoveryConfig: ResolvedConfig = {
			...project.config,
			placeFile: effectivePlaceFile,
			projects: project.projects,
			testMatch: project.include,
		};

		const discovery = discoverTestFiles(discoveryConfig, cliFiles);
		const { runtimeFiles, typeTestFiles } = classifyTestFiles(discovery.files, rootConfig);

		const projConfig: ResolvedConfig = narrowConfigByFiles(
			{ ...discoveryConfig, testMatch: project.testMatch },
			cliFiles ?? [],
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
	jobs: Array<ProjectJob>,
	pendingJobs: Array<PendingJob>,
	parallel: ParallelOption,
): Promise<Array<ProjectResult>> {
	if (jobs.length === 0) {
		await backend.close?.();
		return [];
	}

	const startTime = Date.now();
	let backendResult;
	try {
		backendResult = await executeBackend(backend, jobs, parallel);
	} finally {
		await backend.close?.();
	}

	const sharedTiming = backendResult.timing;
	const projectResults: Array<ProjectResult> = [];
	for (const [index, entry] of backendResult.results.entries()) {
		// eslint-disable-next-line ts/no-non-null-assertion -- backend invariant: results.length === jobs.length
		const pending = pendingJobs[index]!;
		// eslint-disable-next-line ts/no-non-null-assertion -- backend invariant: results.length === jobs.length
		const jobConfig = jobs[index]!.config;

		const executeResult = processProjectResult(entry, {
			backendTiming: sharedTiming,
			config: jobConfig,
			deferFormatting: true,
			startTime,
			version: VERSION,
		});
		projectResults.push({
			displayColor: pending.displayColor,
			displayName: pending.displayName,
			result: executeResult,
		});
	}

	return projectResults;
}

function loadRojoTree(config: ResolvedConfig): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fs.readFileSync(rojoPath, "utf8");
	const parsed: unknown = JSON.parse(content);
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
