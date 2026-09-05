import * as path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { resolveBackendAsync } from "../backends/auto.ts";
import type { Backend, ParallelOption } from "../backends/interface.ts";
import { resolveTestProgressMapId } from "../backends/test-progress-map.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import { type ProjectInput, runProjectsAsync } from "../executor.ts";
import { describePlaceFile } from "../progress/stages.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckPassAsync as runGroupedTypecheckPassAsync } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckAsync } from "../typecheck/runner.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { emitRunHeader } from "./run-header.ts";
import type { StagedRun } from "./staging.ts";
import { collectStubMounts } from "./staging.ts";
import type { PendingJob, RunDiscovery, TestPlan } from "./test-plan.ts";
import type { ProjectResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
const VERSION = packageJson.version;

export interface ExecutionInput {
	cli: RunOptions["cli"];
	discovery: RunDiscovery;
	plan: TestPlan;
	staged: StagedRun;
}

export interface ExecutionOutcome {
	/**
	 * Host time spent building the place this run dispatches against, 0 when
	 * the run built none here. Staging's own measurement covers everything
	 * before the backend resolved, so the two sum to the run's staging cost.
	 */
	placeBuildMs: number;
	projectResults: Array<ProjectResult>;
	typecheck: TypecheckPassOutcome;
}

/**
 * One tsgo pass per distinct `(tsconfig, cwd)` group: projects sharing a
 * tsconfig collapse to a single compilation, projects with distinct tsconfigs
 * are each checked against their own, and diagnostics are attributed back to
 * each project's tests via the merged result. `ignoreSourceErrors` and
 * `spawnTimeout` are run-wide reporting policy, resolved from root
 * `test.typecheck` + CLI (the per-project tsconfig drives grouping, not the
 * source-error decision), then applied to every group's pass.
 */
export async function runTypecheckPassAsync(
	entries: Array<TypecheckGroupEntry>,
	rootConfig: ResolvedConfig,
	cliTypecheck: TypecheckCliOptions,
): Promise<TypecheckPassOutcome> {
	const rootTypecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	return runGroupedTypecheckPassAsync(entries, async (group) => {
		return runTypecheckAsync({
			files: group.files,
			ignoreSourceErrors: rootTypecheck.ignoreSourceErrors,
			rootDir: group.cwd,
			spawnTimeout: rootTypecheck.spawnTimeout,
			timeout: rootConfig.timeout,
			tsconfig: group.tsconfig,
		});
	});
}

/**
 * Run a `TestPlan`: resolve a backend, build the open-cloud place when one is
 * needed, then run the Roblox jobs and the host-side tsgo pass concurrently.
 *
 * Everything that needs a backend lives inside the `finally` guard — including
 * the place build, which reads `backend.kind`. Building outside the guard would
 * leak an unclosed backend whenever rojo fails.
 */
export async function executeTestPlanAsync(input: ExecutionInput): Promise<ExecutionOutcome> {
	const { cli, staged } = input;
	const backend = await input.discovery.timing.profileAsync("resolveBackend", async () => {
		return resolveBackendAsync(cli, staged.effectiveConfig);
	});

	try {
		return await runAgainstBackendAsync(backend, input);
	} finally {
		await backend.closeAsync?.();
	}
}

function toExecutorProject(job: PendingJob): ProjectInput {
	return {
		config: job.config,
		displayColor: job.displayColor,
		displayName: job.displayName,
		runtimeInjectionPaths: job.runtimeInjectionPaths,
		testFiles: job.runtimeFiles,
	};
}

async function runJobsAsync({
	backend,
	fileSystem,
	jobs,
	parallel,
	timing,
	vmParallel,
}: {
	backend: Backend;
	fileSystem: FileSystem;
	jobs: Array<PendingJob>;
	parallel: ParallelOption;
	timing: TimingCollector;
	vmParallel: ParallelOption;
}): Promise<Array<ProjectResult>> {
	if (jobs.length === 0) {
		return [];
	}

	const runResult = await timing.profileAsync("runProjects", async () => {
		return runProjectsAsync({
			backend,
			deferFormatting: true,
			fileSystem,
			parallel,
			projects: jobs.map(toExecutorProject),
			startTime: Date.now(),
			testProgressMapId: resolveTestProgressMapId(backend),
			timing,
			version: VERSION,
			vmParallel,
		});
	});

	// Paired through `ranProjectIndices` rather than positionally: `results`
	// carries one entry per job that RAN, and a `--bail` run comes back short.
	// Multi cannot bail today, so this is the identity mapping — reading the
	// index is what keeps it right if that ever changes.
	return runResult.results.map((executeResult, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- parallel to results
		const job = jobs[runResult.ranProjectIndices[index]!]!;
		return {
			displayColor: job.displayColor,
			displayName: job.displayName,
			result: executeResult,
		};
	});
}

async function buildOpenCloudPlaceAsync(
	fileSystem: FileSystem,
	rootConfig: ResolvedConfig,
	projects: Array<ResolvedProjectConfig>,
	cacheRoot: string,
): Promise<void> {
	const userRojoProjectPath = path.resolve(
		rootConfig.rootDir,
		rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
	);

	await buildPlaceAsync({
		fileSystem,
		packages: [
			{
				name: "multi-project",
				packageDirectory: rootConfig.rootDir,
				rojoProjectPath: userRojoProjectPath,
				stubMounts: collectStubMounts(projects, rootConfig.rootDir, cacheRoot),
			},
		],
		placeFile: resolvePlaceFilePath(rootConfig),
		projectFile: path.resolve(cacheRoot, "synth.project.json"),
		wrap: false,
	});
}

/**
 * Build the place a non-coverage open-cloud run dispatches against, and report
 * how long it took.
 *
 * Timed rather than merely elapsed-through: the build lands before the dispatch
 * window opens, so its cost falls outside every phase the backend measures. A
 * coverage run builds nothing here — `prepareCoverage` already built the
 * instrumented place, and `stageRun` charged that build to staging too, so the
 * two paths report the same phase under the same name.
 */
async function buildPlaceForBackendAsync(
	backend: Backend,
	{ discovery, staged }: ExecutionInput,
): Promise<number> {
	const { fileSystem, projects, rootConfig, timing } = discovery;
	if (rootConfig.collectCoverage || backend.kind !== "open-cloud") {
		return 0;
	}

	const { elapsedMs } = await timing.profileTimedAsync("buildOpenCloudPlace", async () => {
		await buildOpenCloudPlaceAsync(fileSystem, rootConfig, projects, staged.cacheRoot);
		// Inside the span: closing it closes the stage, and a size handed over
		// after that arrives too late to reach the line the stage prints.
		timing.progress.describe(
			"build",
			describePlaceFile(resolvePlaceFilePath(rootConfig), fileSystem),
		);
	});
	return elapsedMs;
}

function effectiveParallelForBackend(
	parallel: ParallelOption,
	backend: { kind: string },
): ParallelOption {
	return backend.kind === "open-cloud" ? parallel : undefined;
}

/**
 * The two concurrency knobs a run carries, each already narrowed to the
 * backend that can serve it: `parallel` shards Open Cloud sessions, while
 * `vmParallel` splits one Studio session across Luau VMs.
 */
function resolveConcurrency(
	config: ResolvedConfig,
	backend: Backend,
): { parallel: ParallelOption; vmParallel: ParallelOption } {
	return {
		parallel: effectiveParallelForBackend(config.parallel, backend),
		vmParallel: config.experimentalVmParallel,
	};
}

/** The run header, with every field it prints taken off the resolved config. */
function emitConfiguredRunHeader(rootConfig: ResolvedConfig, timing: TimingCollector): void {
	emitRunHeader({
		collectCoverage: rootConfig.collectCoverage,
		color: rootConfig.color,
		formatters: rootConfig.formatters,
		progress: timing.progress,
		rootDir: rootConfig.rootDir,
		silent: rootConfig.silent,
		verbose: rootConfig.verbose,
		version: VERSION,
	});
}

async function runAgainstBackendAsync(
	backend: Backend,
	input: ExecutionInput,
): Promise<ExecutionOutcome> {
	const { discovery, plan, staged } = input;
	const { cliTypecheck, rootConfig, timing } = discovery;
	const placeBuildMs = await buildPlaceForBackendAsync(backend, input);

	if (plan.jobs.length > 0) {
		emitConfiguredRunHeader(rootConfig, timing);
	}

	// The tsgo pass runs concurrently with the jobs so the local CPU-bound type
	// checking overlaps the network-bound Open Cloud upload/poll.
	const concurrency = resolveConcurrency(staged.effectiveConfig, backend);
	const [projectResults, typecheck] = await Promise.all([
		runJobsAsync({
			backend,
			fileSystem: discovery.fileSystem,
			jobs: plan.jobs,
			timing,
			...concurrency,
		}),
		runTypecheckPassAsync(plan.typeTestEntries, rootConfig, cliTypecheck),
	]);

	// Record the tsgo span at root once both branches settle — the collector's
	// LIFO stack is not concurrency-safe, so the pass must not `profile` while
	// `runJobs` is open. `elapsedMs` is 0 (and skipped) when there are no Type
	// Tests; otherwise the sibling span makes the overlap visible (host TOTAL
	// sums the two while wall-clock is the longer of them).
	if (typecheck.elapsedMs > 0) {
		timing.record("runTypecheck", typecheck.elapsedMs);
	}

	return { placeBuildMs, projectResults, typecheck };
}
