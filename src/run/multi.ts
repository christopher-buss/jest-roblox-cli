import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";

import type { Backend } from "../backends/interface.ts";
import { filterProjectsByFiles } from "../config/filter-projects-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { resolveCodeRoots } from "../staging/code-roots.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "../timing/orchestration-collector.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { resolveAllSetupFilePaths } from "./discovery.ts";
import { resolveRunBackendAsync, runTestPlanAsync, runTypecheckPassAsync } from "./execution.ts";
import { buildMultiRunResult } from "./multi-result.ts";
import type { RunSeams } from "./seams.ts";
import { nodeRunSeams } from "./seams.ts";
import { stageRunAsync } from "./staging.ts";
import type { EmptyRunPolicy, RunDiscovery, TestPlan } from "./test-plan.ts";
import { bindTestPlanToPlace, buildTestPlan } from "./test-plan.ts";
import type { MultiRunResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
/**
 * Everything this run writes for itself, framed on `rootDir`. One Code Root
 * covers the lot: the generated `jest.config` stubs under `cache/`, and the
 * coverage shadow and its spine copies under `coverage/` — which hang off the
 * invocation directory, the same place a multi run is invoked from.
 */
const STAGING_DIRECTORY = ".jest-roblox";

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
	seams: RunSeams;
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
	{ cli, fileSystem, seams, timing }: ResolvedRunInput,
): Promise<MultiRunResult> {
	const discovery = beginRun(allProjects, rootConfig, { cli, fileSystem, seams, timing });
	if (isTypecheckOnlyRun(discovery)) {
		return runMultiTypecheckOnlyAsync(discovery);
	}

	// Discovered before anything is resolved or written. A plan that selected
	// nothing stops the run here, so an empty one still costs no backend, no
	// instrumentation and no place — the invariant `TestPlan.emptiness`
	// states, now that staging comes after the backend rather than before it.
	// The jobs are aimed at a place below, once the run has built one.
	const plan = buildTestPlan(discovery);
	if (plan.emptiness !== undefined) {
		return emptyMultiResult(plan.emptiness);
	}

	// Resolved before staging, because staging is what decides whether the
	// place holds this run's code, and only the backend can answer that.
	// Against the root config rather than `staged.effectiveConfig`: the two
	// differ only in `placeFile`, which `resolveBackend` never reads, and the
	// effective one does not exist yet.
	const backend = await resolveRunBackendAsync({ cli, config: rootConfig, seams, timing });
	try {
		return await stageAndExecuteAsync({ backend, cli, discovery, plan, rootConfig });
	} finally {
		// Widened to cover staging: with the backend resolved first, a rojo
		// failure there would otherwise leave an open one behind.
		await backend.closeAsync?.();
	}
}

export async function runMultiProjectAsync(options: MultiRunOptions): Promise<MultiRunResult> {
	const { cli, config: rootConfig, fileSystem = nodeFileSystem, rawProjects } = options;
	const seams = { ...nodeRunSeams(), ...options.seams };
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig, fileSystem));

	const allProjects = await timing.profileAsync("resolveAllProjects", async () => {
		return seams.resolveAllProjects(rawProjects, rootConfig, {
			cwd: rootConfig.rootDir,
			fileSystem,
			rojoTree,
			tsconfigReader: seams.tsconfigReader,
		});
	});

	return runResolvedProjectsAsync(allProjects, rootConfig, { cli, fileSystem, seams, timing });
}

/**
 * The Code Roots this run's Code Bundle is split against, or none when it ships
 * the whole place.
 */
function resolveRunCodeRoots({
	backend,
	discovery,
	rootConfig,
}: {
	backend: Backend;
	discovery: RunDiscovery;
	rootConfig: ResolvedConfig;
}): Array<PosixRoot> | undefined {
	return resolveCodeRoots({
		backendKind: backend.kind,
		binaryInput: rootConfig.binaryInput,
		configs: discovery.projects.map((project) => project.config),
		fileSystem: discovery.fileSystem,
		stagingDirectory: path.resolve(rootConfig.rootDir, STAGING_DIRECTORY),
		tsconfigReader: discovery.seams.tsconfigReader,
	});
}

/**
 * Put the run's inputs on disk against a backend already in hand, then dispatch
 * against it.
 */
async function stageAndExecuteAsync({
	backend,
	cli,
	discovery,
	plan,
	rootConfig,
}: {
	backend: Backend;
	cli: RunOptions["cli"];
	discovery: RunDiscovery;
	plan: TestPlan;
	rootConfig: ResolvedConfig;
}): Promise<MultiRunResult> {
	const { fileSystem, seams, timing } = discovery;
	// Resolved here rather than carried back out of staging: the coverage build
	// inside it and the non-coverage build after it are two halves of one
	// decision, so the decision is made once, above both.
	const codeRoots = resolveRunCodeRoots({ backend, discovery, rootConfig });
	const staged = await stageRunAsync({
		codeRoots,
		fileSystem,
		projects: discovery.projects,
		rootConfig,
		seams,
		timing,
	});
	// Only now does the run know where the jobs execute: a coverage run built
	// an instrumented place of its own while this plan was already in hand.
	const dispatchPlan = bindTestPlanToPlace(plan, staged.effectiveConfig.placeFile);
	const outcome = await runTestPlanAsync({
		backend,
		cli,
		codeRoots,
		discovery,
		plan: dispatchPlan,
		staged,
	});
	return buildMultiRunResult({ cli, discovery, outcome, plan: dispatchPlan, staged });
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
	{ cli, fileSystem, seams, timing }: ResolvedRunInput,
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
		resolveAllSetupFilePaths(
			allProjects.map((project) => project.config),
			seams.createSetupResolver,
		);
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
		seams,
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

/**
 * What a run that selected nothing reports.
 *
 * No coverage and no staging time, because a run that stops on an empty plan
 * has done neither: the plan is built before the backend so that nothing is
 * resolved, instrumented or written for a run with no tests to run.
 */
function emptyMultiResult(emptiness: EmptyRunPolicy): MultiRunResult {
	return {
		coverageMs: 0,
		merged: {},
		mode: "multi",
		projectResults: [],
		stagingMs: 0,
		...emptiness,
	};
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
	const plan = buildTestPlan(discovery);
	if (plan.emptiness !== undefined) {
		return emptyMultiResult(plan.emptiness);
	}

	const typecheck = await runTypecheckPassAsync(
		plan.typeTestEntries,
		discovery.rootConfig,
		discovery.cliTypecheck,
		discovery.seams.runTypecheck,
	);
	discovery.timing.record("runTypecheck", typecheck.elapsedMs);
	return { ...emptyMultiResult({}), typecheckResult: typecheck.result };
}
