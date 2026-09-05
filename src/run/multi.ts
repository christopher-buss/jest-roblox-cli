import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";

import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { resolveAllSetupFilePaths } from "./discovery.ts";
import { executeTestPlanAsync, runTypecheckPassAsync } from "./execution.ts";
import { buildMultiRunResult } from "./multi-result.ts";
import type { StagedRun } from "./staging.ts";
import { stageRunAsync } from "./staging.ts";
import type { EmptyRunPolicy, RunDiscovery } from "./test-plan.ts";
import { buildTestPlan } from "./test-plan.ts";
import type { MultiRunResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";

export interface MultiRunOptions extends RunOptions {
	rawProjects: Array<ProjectEntry>;
}

/**
 * The run-wide inputs discovery and execution share, with the seam already
 * settled — resolved once at the entry point rather than re-defaulted at each
 * layer, so no stage below can reach the real disk by omitting it.
 */
export interface ResolvedRunInput {
	cli: RunOptions["cli"];
	fileSystem: FileSystem;
	timing: TimingCollector;
}

interface SelectedProjects {
	filesByProject?: ReadonlyMap<string, Array<string>> | undefined;
	projects: Array<ResolvedProjectConfig>;
}

export function loadRojoTree(
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
): RojoTreeNode {
	const rojoPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const content = fileSystem.readFileSync(rojoPath, "utf8");
	const parsed = JSON.parse(content);
	const validated = rojoProjectSchema(parsed);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Rojo project: ${validated.summary}`);
	}

	return resolveNestedProjects(validated.tree, path.dirname(rojoPath), fileSystem);
}

/**
 * Multi-project execution core: staging, test-plan building, and execution over
 * a set of already-resolved projects. Shared by the `projects:`-configured path
 * (`runMultiProject`) and the no-`projects` collapse (`run.ts` synthesizes one
 * project from the config's luau roots and calls this), so both paths get
 * identical per-root `jest.config` stub injection, place rebuild, coverage, and
 * result shaping.
 */
export async function runResolvedProjectsAsync(
	allProjects: Array<ResolvedProjectConfig>,
	rootConfig: ResolvedConfig,
	{ cli, fileSystem, timing }: ResolvedRunInput,
): Promise<MultiRunResult> {
	const discovery = beginRun(allProjects, rootConfig, { cli, fileSystem, timing });
	if (isTypecheckOnlyRun(discovery)) {
		return runMultiTypecheckOnlyAsync(discovery);
	}

	const staged = await stageRunAsync(discovery.projects, rootConfig, timing, fileSystem);
	const plan = buildTestPlan({
		...discovery,
		effectivePlaceFile: staged.effectiveConfig.placeFile,
	});
	if (plan.emptiness !== undefined) {
		return emptyMultiResult(staged, plan.emptiness);
	}

	const outcome = await executeTestPlanAsync({ cli, discovery, plan, staged });
	return buildMultiRunResult({ cli, discovery, outcome, plan, staged });
}

export async function runMultiProjectAsync(options: MultiRunOptions): Promise<MultiRunResult> {
	const { cli, config: rootConfig, fileSystem = nodeFileSystem, rawProjects } = options;
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig, fileSystem));

	const allProjects = await timing.profileAsync("resolveAllProjects", async () => {
		return resolveAllProjects(rawProjects, rootConfig, {
			cwd: rootConfig.rootDir,
			fileSystem,
			rojoTree,
		});
	});

	return runResolvedProjectsAsync(allProjects, rootConfig, { cli, fileSystem, timing });
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

/**
 * Resolve the run's shared discovery inputs: the CLI typecheck layer, the
 * setup-file rewrite, and the `--project`/positional project selection.
 */
function beginRun(
	allProjects: Array<ResolvedProjectConfig>,
	rootConfig: ResolvedConfig,
	{ cli, fileSystem, timing }: ResolvedRunInput,
): RunDiscovery {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};

	// Rewrites setup specifiers to DataModel paths in place. Must precede
	// staging: `toBuildManifestProjects` bakes the resolved paths into the Build
	// Manifest the coverage place is published with.
	timing.profile("resolveSetupFilePaths", () => {
		resolveAllSetupFilePaths(allProjects.map((project) => project.config));
	});

	const { filesByProject, projects } = timing.profile("selectProjects", () => {
		return selectProjects(allProjects, cli.project, cli.files, rootConfig.rootDir);
	});
	return {
		cliFiles: cli.files,
		cliTypecheck,
		filesByProject,
		fileSystem,
		projects,
		rootConfig,
		timing,
	};
}

/**
 * Pure-local tsgo short-circuit. When every selected project runs
 * Type-Tests-only (`--typecheckOnly`, or each project's own
 * `test.typecheck.only`), no runtime jobs are possible — so the run skips the
 * backend, the place build, and coverage entirely. This is the cross-mode
 * `--typecheckOnly` invariant: no mode resolves a backend for a type-only run,
 * and the collapse path does not even require a Rojo project on disk.
 */
function isTypecheckOnlyRun({ cliTypecheck, projects, rootConfig }: RunDiscovery): boolean {
	return projects.every((project) => {
		return resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: rootConfig.typecheck,
		}).only;
	});
}

// Runs the host-side Type Test pass alone — no staging, no backend, no place
// build, no coverage. Discovery still goes through the shared `buildTestPlan`
// (so `-d` derivation, per-project tsconfig grouping, and excludes match the
// runtime path); the runtime jobs it returns are necessarily empty here.
//
// No run header either: a type-only run drives no Roblox jobs, matching
// workspace mode and the prior behaviour (the header was gated on a non-empty
// runtime job set).
async function runMultiTypecheckOnlyAsync(discovery: RunDiscovery): Promise<MultiRunResult> {
	const plan = buildTestPlan({
		...discovery,
		// No place is built on a type-only run; the runtime place file is unused
		// because the (empty) jobs are discarded.
		effectivePlaceFile: discovery.rootConfig.placeFile,
	});
	const empty: MultiRunResult = {
		coverageMs: 0,
		merged: {},
		mode: "multi",
		projectResults: [],
		stagingMs: 0,
	};
	if (plan.emptiness !== undefined) {
		return { ...empty, ...plan.emptiness };
	}

	const typecheck = await runTypecheckPassAsync(
		plan.typeTestEntries,
		discovery.rootConfig,
		discovery.cliTypecheck,
	);
	discovery.timing.record("runTypecheck", typecheck.elapsedMs);
	return { ...empty, typecheckResult: typecheck.result };
}

function emptyMultiResult(staged: StagedRun, emptiness: EmptyRunPolicy): MultiRunResult {
	return {
		coverageArtifacts: staged.coverageArtifacts,
		coverageMs: staged.coverageMs,
		merged: {},
		mode: "multi",
		projectResults: [],
		stagingMs: staged.stagingMs,
		...emptiness,
	};
}
