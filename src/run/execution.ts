import * as path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend, ParallelOption } from "../backends/interface.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { resolvePlaceFilePath } from "../config/schema.ts";
import type { ProjectInput } from "../executor.ts";
import { describePlaceFile } from "../progress/stages.ts";
import type {
	CodeBundleArtifact,
	PlaceBuildResult,
	PlaceReuseOptions,
} from "../staging/place-builder.ts";
import { buildPlaceAsync } from "../staging/place-builder.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckPassAsync as runGroupedTypecheckPassAsync } from "../typecheck/group-by-tsconfig.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { emitRunHeader } from "./run-header.ts";
import type { RunSeams } from "./seams.ts";
import type { StagedRun } from "./staging.ts";
import { collectStubMounts } from "./staging.ts";
import type { PendingJob, RunDiscovery, TestPlan } from "./test-plan.ts";
import type { ProjectResult, RunOptions } from "./types.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";
/** Where the last non-coverage build's key and place hash are recorded. */
const PLACE_REUSE_FILE = "synth.place-cache.json";
/**
 * Sits beside the reuse record and shares its lifetime: both answer for the
 * same set of inputs, and a run that discards one has nothing to gain by
 * keeping the other.
 */
const INPUT_DIGEST_FILE = "synth.input-digests";
const VERSION = packageJson.version;

export interface ExecutionInput {
	backend: Backend;
	cli: RunOptions["cli"];
	/**
	 * Build a Harness Place, splitting the mounts inside these Code Roots into
	 * a Code Bundle beside it. The same value staging was given, so the place a
	 * non-coverage run builds here is split by the decision a coverage run's
	 * place was.
	 */
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
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

/** Where the non-coverage open-cloud place is built, and from what. */
interface OpenCloudPlaceOptions {
	cacheRoot: string;
	childProcess: ChildProcessRunner;
	codeRoots: ReadonlyArray<PosixRoot> | undefined;
	fileSystem: FileSystem;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

/** What the pre-dispatch place build produced, and what it cost. */
interface PlaceBuildOutcome {
	codeBundle?: CodeBundleArtifact | undefined;
	elapsedMs: number;
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
	runTypecheck: RunSeams["runTypecheck"],
): Promise<TypecheckPassOutcome> {
	const rootTypecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	return runGroupedTypecheckPassAsync(entries, async (group) => {
		return runTypecheck({
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
 * The backend this run dispatches against, resolved before anything is staged.
 *
 * Staging decides whether the place holds the run's code, and only the backend
 * says whether it may be taken out — so the resolution comes first and the
 * caller's close guard widens to cover everything after it.
 */
export async function resolveRunBackendAsync({
	cli,
	config,
	seams,
	timing,
}: {
	cli: RunOptions["cli"];
	config: ResolvedConfig;
	seams: RunSeams;
	timing: TimingCollector;
}): Promise<Backend> {
	return timing.profileAsync("resolveBackend", async () => seams.resolveBackend(cli, config));
}

/**
 * Run a `TestPlan` against a backend the caller resolved and owns: build the
 * open-cloud place when one is needed, then run the Roblox jobs and the
 * host-side tsgo pass concurrently.
 */
export async function runTestPlanAsync(input: ExecutionInput): Promise<ExecutionOutcome> {
	const { backend, discovery, plan, staged } = input;
	const { cliTypecheck, rootConfig, timing } = discovery;
	const placeBuild = await buildPlaceForBackendAsync(input);

	if (plan.jobs.length > 0) {
		emitConfiguredRunHeader(rootConfig, timing);
	}

	// The tsgo pass runs concurrently with the jobs so the local CPU-bound type
	// checking overlaps the network-bound Open Cloud upload/poll.
	const dispatch = resolveDispatchOptions(staged.effectiveConfig, backend);
	const [projectResults, typecheck] = await Promise.all([
		runJobsAsync({
			backend,
			// One of the two builds wrote it: a coverage run's place is built
			// inside staging, every other open-cloud place just above.
			codeBundle: staged.codeBundle ?? placeBuild.codeBundle,
			fileSystem: discovery.fileSystem,
			jobs: plan.jobs,
			runProjects: discovery.seams.runProjects,
			timing,
			...dispatch,
		}),
		runTypecheckPassAsync(
			plan.typeTestEntries,
			rootConfig,
			cliTypecheck,
			discovery.seams.runTypecheck,
		),
	]);

	// Record the tsgo span at root once both branches settle — the collector's
	// LIFO stack is not concurrency-safe, so the pass must not `profile` while
	// `runJobs` is open. `elapsedMs` is 0 (and skipped) when there are no Type
	// Tests; otherwise the sibling span makes the overlap visible (host TOTAL
	// sums the two while wall-clock is the longer of them).
	if (typecheck.elapsedMs > 0) {
		timing.record("runTypecheck", typecheck.elapsedMs);
	}

	return { placeBuildMs: placeBuild.elapsedMs, projectResults, typecheck };
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
	codeBundle,
	fileSystem,
	jobs,
	parallel,
	runProjects,
	timing,
	vmParallel,
}: {
	backend: Backend;
	codeBundle: CodeBundleArtifact | undefined;
	fileSystem: FileSystem;
	jobs: Array<PendingJob>;
	parallel: ParallelOption;
	runProjects: RunSeams["runProjects"];
	timing: TimingCollector;
	vmParallel: ParallelOption;
}): Promise<Array<ProjectResult>> {
	if (jobs.length === 0) {
		return [];
	}

	const runResult = await timing.profileAsync("runProjects", async () => {
		return runProjects({
			backend,
			codeBundle,
			deferFormatting: true,
			fileSystem,
			parallel,
			projects: jobs.map(toExecutorProject),
			startTime: Date.now(),
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

/**
 * The gate a non-coverage open-cloud build reuses its place through.
 *
 * No manifests and no shadow roots: this is the path a coverage run never
 * takes, so every input is walked off disk. On a harness build what is left to
 * walk is what stayed — which is the whole point, and what lets a code-only
 * edit skip the rojo build as well as the upload.
 */
function placeReuseFor(cacheRoot: string): PlaceReuseOptions {
	return {
		cacheFile: path.resolve(cacheRoot, PLACE_REUSE_FILE),
		digestCacheFile: path.resolve(cacheRoot, INPUT_DIGEST_FILE),
	};
}

async function buildOpenCloudPlaceAsync({
	cacheRoot,
	childProcess,
	codeRoots,
	fileSystem,
	projects,
	rootConfig,
}: OpenCloudPlaceOptions): Promise<PlaceBuildResult> {
	const userRojoProjectPath = path.resolve(
		rootConfig.rootDir,
		rootConfig.rojoProject ?? DEFAULT_ROJO_PROJECT,
	);

	return buildPlaceAsync({
		childProcess,
		codeRoots,
		fileSystem,
		packages: [
			{
				name: "multi-project",
				packageDirectory: rootConfig.rootDir,
				rojoProjectPath: userRojoProjectPath,
				stubMounts: collectStubMounts({
					cacheRoot,
					fileSystem,
					projects,
					rootDir: rootConfig.rootDir,
				}),
			},
		],
		placeFile: resolvePlaceFilePath(rootConfig),
		projectFile: path.resolve(cacheRoot, "synth.project.json"),
		reuse: placeReuseFor(cacheRoot),
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
async function buildPlaceForBackendAsync({
	backend,
	codeRoots,
	discovery,
	staged,
}: ExecutionInput): Promise<PlaceBuildOutcome> {
	const { fileSystem, projects, rootConfig, seams, timing } = discovery;
	if (rootConfig.collectCoverage || backend.kind !== "open-cloud") {
		return { elapsedMs: 0 };
	}

	const { elapsedMs, value } = await timing.profileTimedAsync("buildOpenCloudPlace", async () => {
		const built = await buildOpenCloudPlaceAsync({
			cacheRoot: staged.cacheRoot,
			childProcess: seams.childProcess,
			codeRoots,
			fileSystem,
			projects,
			rootConfig,
		});
		// Inside the span: closing it closes the stage, and a size handed
		// over after that arrives too late to reach the line the stage
		// prints.
		timing.progress.describe(
			"build",
			describePlaceFile(resolvePlaceFilePath(rootConfig), fileSystem),
		);
		return built;
	});
	return { codeBundle: value.codeBundle, elapsedMs };
}

function effectiveParallelForBackend(
	parallel: ParallelOption,
	backend: { kind: string },
): ParallelOption {
	return backend.kind === "open-cloud" ? parallel : undefined;
}

/**
 * The per-run knobs a dispatch carries, each already narrowed to the backend
 * that can serve it: `parallel` shards Open Cloud sessions, and `vmParallel`
 * splits one Studio session across Luau VMs.
 */
function resolveDispatchOptions(
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
