import { loadConfig } from "./config/loader.ts";
import { prepareWorkspaceCoverage } from "./coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "./executor.ts";
import { createTsconfigMappingCache, nodeTsconfigReader } from "./executor/tsconfig-mappings.ts";
import type { CodeBundleArtifact } from "./staging/code-bundle.ts";
import { resolveCodeRoots } from "./staging/code-roots.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import { runTypecheckAsync } from "./typecheck/runner.ts";
import { assertTypecheckAvailable } from "./typecheck/typecheck-groups.ts";
import { nodeChildProcessRunner } from "./utils/child-process.ts";
import { nodeFileSystem } from "./utils/file-system.ts";
import type { PosixRoot } from "./utils/normalize-windows-path.ts";
import { nodeRojoResolverFactory } from "./utils/rojo-project-reader.ts";
import { openWorkspaceRunAsync } from "./workspace-runner-open.ts";
import type {
	ResolvedRunWorkspaceOptions,
	RunWorkspaceOptions,
	WorkspaceRuntimeInput,
} from "./workspace-runner-types.ts";
import { attachCoverageManifests } from "./workspace/coverage-attach.ts";
import type { WorkspaceDispatchSpec, WorkspaceJob } from "./workspace/dispatch.ts";
import {
	buildWorkspaceJobs,
	prepareWorkspaceDispatchAsync,
	runDispatchedProjectsAsync,
} from "./workspace/dispatch.ts";
import { writeWorkspaceSinksAsync } from "./workspace/output-sinks.ts";
import type { LoadedPackage } from "./workspace/package-loader.ts";
import type { PendingEntry } from "./workspace/pending-entry.ts";
import { type StagedWorkspacePlace, stageWorkspacePlaceAsync } from "./workspace/place-staging.ts";
import type { WorkspaceTestSelection } from "./workspace/test-selection.ts";
import {
	attachTypecheck,
	runTypecheckOnlyWorkspaceAsync,
	runWorkspaceTypecheckPassAsync,
	type WorkspaceRunnerOutput,
	type WorkspaceTypecheckPass,
} from "./workspace/typecheck-pass.ts";

export type { RunWorkspaceOptions } from "./workspace-runner-types.ts";
export type { WorkspaceProjectResult } from "./workspace/coverage-attach.ts";
export type { WorkspaceRunnerOutput } from "./workspace/typecheck-pass.ts";

interface WriteRuntimeSinksOptions {
	options: ResolvedRunWorkspaceOptions;
	pending: Array<PendingEntry>;
	results: Array<ExecuteResult>;
	selection: WorkspaceTestSelection;
	typecheckPass: WorkspaceTypecheckPass;
}

/**
 * Run the tests of every workspace package.
 * @param options - Run inputs. Omitted seams default to the Node implementations.
 * @returns The run output, or `undefined` when preflight or test selection rejected the run.
 */
export async function runWorkspaceAsync(
	options: RunWorkspaceOptions,
): Promise<undefined | WorkspaceRunnerOutput> {
	const {
		childProcess = nodeChildProcessRunner,
		createResolver = nodeRojoResolverFactory,
		fileSystem = nodeFileSystem,
		loadPackageConfig = loadConfig,
		prepareCoverage = prepareWorkspaceCoverage,
		runTypecheck = runTypecheckAsync,
		tsconfigReader = nodeTsconfigReader,
	} = options;
	return runWorkspaceProfiledAsync(
		{
			...options,
			childProcess,
			createResolver,
			fileSystem,
			loadPackageConfig,
			prepareCoverage,
			runTypecheck,
			tsconfigReader,
		},
		options.timing ?? NOOP_TIMING_COLLECTOR,
	);
}

/**
 * How this run hands its jobs to the backend, measured under its own span.
 * @param options - Jobs, run options and profiler.
 * @returns How the backend receives the jobs.
 */
async function prepareDispatchSpecAsync({
	jobs,
	options,
	timing,
}: {
	jobs: Array<WorkspaceJob>;
	options: ResolvedRunWorkspaceOptions;
	timing: TimingCollector;
}): Promise<WorkspaceDispatchSpec> {
	return timing.profileAsync("prepareDispatch", async () => {
		return prepareWorkspaceDispatchAsync({
			bail: options.runOptions.bail,
			jobs,
			onStreamingResult: options.onStreamingResult,
			parallel: options.runOptions.parallel,
			prepareWorkStealingQueue: options.prepareWorkStealingQueue,
			vmParallel: options.runOptions.experimentalVmParallel,
			workStealingCredentials: options.workStealingCredentials,
		});
	});
}

async function executeWorkspaceRunAsync({
	codeBundle,
	options,
	placeFile,
	selection,
	startTime,
	timing,
}: WorkspaceRuntimeInput & {
	codeBundle: CodeBundleArtifact | undefined;
	placeFile: string;
	startTime: number;
}): Promise<{
	ranProjectIndices: Array<number>;
	results: Array<ExecuteResult>;
	typecheckPass: WorkspaceTypecheckPass;
}> {
	const { pending } = selection;

	// Resolved once, for both the script the runtime executes and the run that
	// post-processes its results. The cache goes with them, so a package's
	// tsconfigs are read once for the whole run.
	const { fileSystem, tsconfigReader } = options;
	const tsconfigCache = createTsconfigMappingCache();
	const jobs = timing.profile("buildJobs", () => {
		return buildWorkspaceJobs({
			fileSystem,
			pending,
			placeFile,
			tsconfigCache,
			tsconfigReader,
		});
	});

	const dispatchSpec = await prepareDispatchSpecAsync({ jobs, options, timing });

	// The grouped tsgo pass depends only on the filesystem (discovery already
	// ran), so it overlaps the network-bound Open Cloud upload/poll. Await both,
	// then record the tsgo span — the collector's LIFO stack is not
	// concurrency-safe, so the pass times itself and the span lands after the
	// barrier (same caveat as single/multi).
	const [dispatched, typecheckPass] = await Promise.all([
		runDispatchedProjectsAsync({
			backend: options.backend,
			codeBundle,
			dispatchSpec,
			fileSystem,
			jobs,
			startTime,
			timing,
			tsconfigCache,
			version: options.version,
		}),
		runWorkspaceTypecheckPassAsync({ ...selection, runTypecheck: options.runTypecheck }),
	]);

	return { ...dispatched, typecheckPass };
}

/**
 * Split the selection by what actually ran.
 *
 * The pending entries and the results pair by position, so a bail — which
 * comes back short — has to drop the entries it never reached before anything
 * downstream reads them, or a package's name pairs with its neighbor's result.
 *
 * The report counts packages, not projects, so a package is "not run" only when
 * none of its projects ran. One that got part-way through its projects before
 * the bail landed still ran, and naming it on both sides would count it twice.
 *
 * @param pending - Pending entries in dispatch order.
 * @param ranProjectIndices - Indices of the entries that ran.
 * @returns The packages with no project run, and the entries that ran.
 */
function splitBailedSelection(
	pending: Array<PendingEntry>,
	ranProjectIndices: Array<number>,
): { bailedPackages: Array<string>; ran: Array<PendingEntry> } {
	const ranIndices = new Set(ranProjectIndices);
	const ran: Array<PendingEntry> = [];
	const ranPackages = new Set<string>();
	const skippedPackages = new Set<string>();
	for (const [index, entry] of pending.entries()) {
		if (ranIndices.has(index)) {
			ran.push(entry);
			ranPackages.add(entry.pkg);
		} else {
			skippedPackages.add(entry.pkg);
		}
	}

	return {
		bailedPackages: [...skippedPackages].filter((name) => !ranPackages.has(name)),
		ran,
	};
}

/**
 * The Code Roots this run's Code Bundle is split against, or none when it ships
 * the whole place.
 *
 * Every package's compiled directories plus the workspace cache, which is where
 * the coverage shadow, the spine copies and each package's `jest.config` stub
 * are mounted from.
 *
 * @param options - Cache directory, loaded packages and run options.
 * @returns The Code Roots, or `undefined` for the whole place.
 */
function resolveWorkspaceCodeRoots({
	cacheDirectory,
	loaded,
	options,
}: {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
	options: ResolvedRunWorkspaceOptions;
}): Array<PosixRoot> | undefined {
	return resolveCodeRoots({
		backendKind: options.backend?.kind,
		configs: loaded.map((entry) => entry.pkgConfig),
		fileSystem: options.fileSystem,
		stagingDirectory: cacheDirectory,
		tsconfigReader: options.tsconfigReader,
	});
}

/**
 * Argument shuffle only: `stageWorkspacePlaceAsync` owns the phase measurements
 * this run reports.
 *
 * @param options - Runtime inputs.
 * @returns The staged place.
 */
async function stagePlaceForRunAsync({
	cacheDirectory,
	loaded,
	options,
	selection,
	timing,
}: WorkspaceRuntimeInput): Promise<StagedWorkspacePlace> {
	return stageWorkspacePlaceAsync({
		cacheDirectory,
		childProcess: options.childProcess,
		codeRoots: resolveWorkspaceCodeRoots({ cacheDirectory, loaded, options }),
		fileSystem: options.fileSystem,
		loaded,
		prepareCoverage: options.prepareCoverage,
		selection,
		timing,
		workspaceRoot: options.workspaceRoot,
	});
}

/**
 * The sinks a run with runtime jobs writes, once the results have landed.
 * @param options - Run options, entries, results, selection and type pass.
 */
async function writeRuntimeSinksAsync({
	options,
	pending,
	results,
	selection,
	typecheckPass,
}: WriteRuntimeSinksOptions): Promise<void> {
	await writeWorkspaceSinksAsync({
		fileSystem: options.fileSystem,
		pending,
		results,
		runOptions: options.runOptions,
		typecheckByPackage: typecheckPass.byPackage,
		typecheckResult: typecheckPass.outcome.result,
		typeTestProjects: selection.typeTestProjects,
		verbose: options.cli.verbose,
		workspaceRoot: options.workspaceRoot,
	});
}

async function runWorkspaceRuntimeAsync(
	input: WorkspaceRuntimeInput,
): Promise<WorkspaceRunnerOutput> {
	const { options, selection, timing } = input;
	const staged = await stagePlaceForRunAsync(input);

	const { ranProjectIndices, results, typecheckPass } = await executeWorkspaceRunAsync({
		...input,
		codeBundle: staged.codeBundle,
		placeFile: staged.placeFile,
		// The window opens only now, after staging: staging measured itself and
		// the print layer adds that onto the total, so opening it any earlier
		// would count the same milliseconds twice.
		startTime: Date.now(),
	});

	const { bailedPackages, ran } = splitBailedSelection(selection.pending, ranProjectIndices);

	await writeRuntimeSinksAsync({ options, pending: ran, results, selection, typecheckPass });

	return {
		...attachTypecheck({
			pass: typecheckPass.outcome,
			results: attachCoverageManifests({
				coverageByPackage: staged.coverageByPackage,
				pending: ran,
				results,
			}),
			timing,
		}),
		...(bailedPackages.length > 0 ? { bailedPackages } : {}),
		coverageMs: staged.coverageMs,
		stagingMs: staged.stagingMs,
	};
}

/**
 * No runtime jobs. With Type Tests present (`--typecheckOnly`, or
 * type-test-only packages), skip instrumentation, the synthesized place build,
 * and Open Cloud dispatch entirely — run only the host-side type pass and
 * return it. Without Type Tests, nothing to test.
 *
 * @param options - Run options, selection and profiler.
 * @returns The type pass output, or empty results without Type Tests.
 */
async function runWorkspaceNoRuntimeAsync({
	options,
	selection,
	timing,
}: {
	options: ResolvedRunWorkspaceOptions;
	selection: WorkspaceTestSelection;
	timing: TimingCollector;
}): Promise<WorkspaceRunnerOutput> {
	if (selection.typeTestEntries.length === 0) {
		return { results: [] };
	}

	return runTypecheckOnlyWorkspaceAsync({
		fileSystem: options.fileSystem,
		runOptions: options.runOptions,
		runTypecheck: options.runTypecheck,
		timing,
		typecheckByDirectory: selection.typecheckByDirectory,
		typeTestEntries: selection.typeTestEntries,
		typeTestProjects: selection.typeTestProjects,
		workspaceRoot: options.workspaceRoot,
	});
}

async function runWorkspaceProfiledAsync(
	options: ResolvedRunWorkspaceOptions,
	timing: TimingCollector,
): Promise<undefined | WorkspaceRunnerOutput> {
	const opened = await openWorkspaceRunAsync({ ...options, timing });
	if (opened === undefined) {
		return undefined;
	}

	const { cacheDirectory, loaded, selection } = opened;

	assertTypecheckAvailable(selection.typeTestEntries);

	if (selection.pending.length === 0) {
		return runWorkspaceNoRuntimeAsync({ options, selection, timing });
	}

	return runWorkspaceRuntimeAsync({
		cacheDirectory,
		loaded,
		options,
		selection,
		timing,
	});
}
