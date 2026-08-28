import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Except } from "type-fest";

import { buildProjectResult } from "./backends/envelope.ts";
import type {
	Backend,
	BackendResult,
	BackendTiming,
	ParallelOption,
	ProjectBackendResult,
	ProjectJob,
	RawBackendEntry,
	StreamingHooks,
} from "./backends/interface.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import { resolveSnapshotFormat } from "./config/snapshot-format.ts";
import type { AttributionResult } from "./coverage-pipeline/attribution.ts";
import { harvestAttribution } from "./coverage-pipeline/attribution.ts";
import { resolveTestFileHash } from "./coverage-pipeline/test-file-hash.ts";
import { buildExecutionErrorResult } from "./executor/exec-error.ts";
import { formatExecuteOutput } from "./executor/format-output.ts";
import type { SnapshotWriteCounts } from "./executor/snapshot-writer.ts";
import { findRojoProject, writeSnapshots } from "./executor/snapshot-writer.ts";
import {
	calculateTestsMs,
	printLuauTiming,
	recordBackendTimingSpans,
	recordLuauTimingSpans,
} from "./executor/timing-spans.ts";
import type { TsconfigMappingCache } from "./executor/tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	resolveAllTsconfigMappings,
} from "./executor/tsconfig-mappings.ts";
import type { ExecuteResult } from "./executor/types.ts";
import { LuauScriptError, type SnapshotWrites } from "./reporter/parser.ts";
import { createSourceMapper, type SourceMapper } from "./source-mapper/index.ts";
import { NOOP_TIMING_COLLECTOR, type TimingCollector } from "./timing/orchestration-collector.ts";
import type { JestResult } from "./types/jest-result.ts";
import { rojoProjectSchema } from "./types/rojo.ts";
import type { TimingResult } from "./types/timing.ts";
import type { TsconfigMapping } from "./types/tsconfig.ts";

// `loadCoverageManifest` lives with the rest of the coverage pipeline; it is
// re-exported here because `output.ts` (and its whole-module automock in
// `output.spec.ts`) reaches for it through the executor barrel.
export { loadCoverageManifest } from "./coverage-pipeline/manifest-load.ts";
export { formatExecuteOutput } from "./executor/format-output.ts";
export type { SnapshotWriteCounts } from "./executor/snapshot-writer.ts";
export type { TsconfigDirectories } from "./executor/tsconfig-mappings.ts";
export {
	isLuauProject,
	readTsconfigMapping,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
} from "./executor/tsconfig-mappings.ts";
export type { ExecuteResult, FormatOutputOptions } from "./executor/types.ts";

export interface ProjectInput {
	config: ResolvedConfig;
	displayColor?: string | undefined;
	displayName?: string | undefined;
	pkg?: string | undefined;
	/** Studio-only: forwarded to `ProjectJob.runtimeInjectionPaths`. */
	runtimeInjectionPaths?: Array<string> | undefined;
	testFiles: Array<string>;
}

export interface RunProjectsOptions {
	backend: Backend;
	deferFormatting?: boolean | undefined;
	parallel?: ParallelOption;
	projects: Array<ProjectInput>;
	scriptFactory?: ((jobs: ReadonlyArray<ProjectJob>) => string) | undefined;
	scriptOverride?: string | undefined;
	startTime: number;
	streaming?: StreamingHooks | undefined;
	/**
	 * Span-tree profiler owned by the top-level run. Optional so existing
	 * test seams (which exercise the executor directly) keep working without
	 * threading a collector through; production callers pass one through so
	 * the host waterfall captures `backend.runTests` + per-project
	 * post-processing.
	 */
	timing?: TimingCollector | undefined;
	/**
	 * Tsconfig mappings the caller has already read. Workspace mode resolves
	 * its jobs before it freezes the dispatched script and hands that cache on,
	 * so a package is scanned once for the whole run rather than once here and
	 * once there. Omit it and the run reads its own.
	 */
	tsconfigCache?: TsconfigMappingCache | undefined;
	version: string;
	/**
	 * Studio-only, experimental: how many Luau VMs the plugin splits the jobs
	 * across inside one Studio session. Every other backend ignores it.
	 */
	vmParallel?: ParallelOption;
	workStealing?: boolean | undefined;
}

export interface RunProjectsResult {
	backendTiming: BackendTiming;
	/**
	 * Which entries of `projects` the `results` are for, in the same order.
	 * Every index unless a `--bail` run stopped early, in which case the
	 * packages it never reached are absent — the caller lines its own
	 * per-project state up against this rather than against `projects`.
	 */
	ranProjectIndices: Array<number>;
	results: Array<ExecuteResult>;
}

interface ProcessProjectOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	deferFormatting?: boolean | undefined;
	startTime: number;
	/**
	 * The orchestration collector created by `runJestRoblox`. Required —
	 * the only caller is `runProjects` which always passes its own
	 * collector (NOOP when the top-level run didn't enable TIMING).
	 */
	timing: TimingCollector;
	/**
	 * Shared with the job build, so this run scans a package once, not once
	 * per project.
	 */
	tsconfigCache: TsconfigMappingCache;
	version: string;
}

/**
 * Everything a raw backend entry needs to post-process except the config,
 * which each entry recovers from its own job.
 */
type EntryContext = Except<ProcessProjectOptions, "config">;

interface ProjectArtifacts {
	attribution: AttributionResult | undefined;
	sourceMapper: SourceMapper | undefined;
	writeCounts: SnapshotWriteCounts;
}

/**
 * Resolve one project into the job the runtime runs: `snapshotFormat` per
 * project, so the Luau runner never re-resolves or shares format state across
 * projects (fixes the spike's snapshot-diff regression — C1).
 *
 * Every runtime script is built from these jobs, in both dispatch modes — multi
 * through `runProjectsAsync` above, workspace through the materializer payload
 * (`buildMaterializerInputs`), which resolves its entries here before it
 * freezes the script. Per-project config resolution belongs in this one
 * function for that reason: resolve a field anywhere downstream of the payload
 * and it reaches multi mode only.
 */
export function buildProjectJob(project: ProjectInput, cache: TsconfigMappingCache): ProjectJob {
	return {
		config: resolveSnapshotFormat(project.config, project.testFiles, cache),
		displayColor: project.displayColor,
		displayName: project.displayName ?? "",
		pkg: project.pkg,
		runtimeInjectionPaths: project.runtimeInjectionPaths,
		testFiles: project.testFiles,
	};
}

/**
 * Unified orchestration entry point: builds jobs for every input project,
 * dispatches them through the backend in one call, shapes each raw envelope
 * entry into a `ProjectBackendResult`, then maps each through per-project
 * post-processing. Single-, multi-, and workspace-run callers all funnel
 * through here so the build→execute→shape→process sequence lives in
 * exactly one place.
 *
 * Ordering contract: `results` is in `options.projects` order, and parallel to
 * the returned `ranProjectIndices` — which is every project unless a `--bail`
 * run stopped short of some. Callers pair through that array, not by position
 * in `projects`. Backends MUST return `rawResults` in the order of the jobs
 * that ran, because `runProjects` walks the two together to recover each
 * project's resolved config, and a mismatch post-processes with the wrong one.
 */
export async function runProjectsAsync(options: RunProjectsOptions): Promise<RunProjectsResult> {
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const tsconfigCache = options.tsconfigCache ?? createTsconfigMappingCache();
	const jobs = timing.profile("buildJobs", () => {
		return options.projects.map((project) => buildProjectJob(project, tsconfigCache));
	});

	const {
		bailedJobIndices,
		rawResults,
		timing: backendTiming,
	} = await dispatchToBackendAsync(options, jobs, timing);

	const ranProjectIndices = selectRanIndices(jobs.length, bailedJobIndices);
	assertResultParity(rawResults.length, ranProjectIndices.length);

	const context: EntryContext = {
		backendTiming,
		deferFormatting: options.deferFormatting,
		startTime: options.startTime,
		timing,
		tsconfigCache,
		version: options.version,
	};

	const results = timing.profile("processResults", () => {
		return rawResults.map((raw, index) => {
			// eslint-disable-next-line ts/no-non-null-assertion -- length equality asserted above
			const job = jobs[ranProjectIndices[index]!]!;
			return processOrRecoverEntry(raw, job, context);
		});
	});

	return { backendTiming, ranProjectIndices, results };
}

/**
 * The job indices a dispatch produced results for, in job order.
 */
function selectRanIndices(
	jobCount: number,
	bailedJobIndices: Array<number> | undefined,
): Array<number> {
	const bailed = new Set(bailedJobIndices);
	return Array.from({ length: jobCount }, (_unused, index) => index).filter(
		(index) => !bailed.has(index),
	);
}

async function dispatchToBackendAsync(
	options: RunProjectsOptions,
	jobs: Array<ProjectJob>,
	timing: TimingCollector,
): Promise<BackendResult> {
	return timing.profileAsync("backend.runTests", async () => {
		const result = await options.backend.runTestsAsync({
			jobs,
			parallel: options.parallel,
			progress: timing.progress,
			scriptFactory: options.scriptFactory,
			scriptOverride: options.scriptOverride,
			streaming: options.streaming,
			vmParallel: options.vmParallel,
			workStealing: options.workStealing,
		});
		// Surface backend-measured upload/execute as nested spans of the
		// `backend.runTests` frame currently on the stack. These are
		// absolute numbers the backend already measured itself —
		// `record` injects them directly instead of re-timing in JS.
		recordBackendTimingSpans(timing, result.timing);
		// Same idea for the per-VM Luau phase breakdown: extracted here
		// (rather than from the parsed `ProjectBackendResult` in
		// `processResults` below) so the spans land under this frame
		// instead of the sibling `processResults` frame.
		recordLuauTimingSpans(timing, result.rawResults);
		return result;
	});
}

function assertResultParity(resultCount: number, jobCount: number): void {
	if (resultCount !== jobCount) {
		throw new Error(
			`Backend returned ${resultCount.toString()} results for ${jobCount.toString()} jobs — rawResults must be parallel to jobs`,
		);
	}
}

function writeProjectSnapshots(
	snapshotWrites: SnapshotWrites | undefined,
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
	timing: TimingCollector,
): SnapshotWriteCounts {
	if (snapshotWrites === undefined) {
		return { attempted: 0, failed: 0, written: 0 };
	}

	return timing.profile("writeSnapshots", () => {
		return writeSnapshots(snapshotWrites, config, tsconfigMappings);
	});
}

function buildSourceMapper(
	config: ResolvedConfig,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): SourceMapper | undefined {
	const rojoProjectPath = config.rojoProject ?? findRojoProject(config.rootDir);
	if (rojoProjectPath === undefined || !fs.existsSync(rojoProjectPath)) {
		return undefined;
	}

	try {
		const rojoProjectRaw = JSON.parse(fs.readFileSync(rojoProjectPath, "utf-8"));
		const rojoResult = rojoProjectSchema(rojoProjectRaw);
		if (rojoResult instanceof type.errors) {
			return undefined;
		}

		const resolvedTree = resolveNestedProjects(rojoResult.tree, path.dirname(rojoProjectPath));

		return createSourceMapper({
			mappings: tsconfigMappings,
			rojoProject: { ...rojoResult, tree: resolvedTree },
		});
	} catch {
		return undefined;
	}
}

function resolveTestFilePaths(result: JestResult, sourceMapper: SourceMapper | undefined): void {
	if (sourceMapper === undefined) {
		return;
	}

	for (const file of result.testResults) {
		file.testFilePath =
			sourceMapper.resolveTestFilePath(file.testFilePath) ?? file.testFilePath;
	}
}

/**
 * Everything the resolved tsconfig mappings unlock for one project: the
 * snapshot writes they address, the source mapper they feed, and the
 * attribution keyed off that mapper. The mapper is returned alongside the
 * attribution because the caller threads it into both the formatter and the
 * `ExecuteResult`.
 */
function collectProjectArtifacts(
	{ coverageData, perTestCoverage, result, snapshotWrites }: ProjectBackendResult,
	{ config, timing }: ProcessProjectOptions,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): ProjectArtifacts {
	const writeCounts = writeProjectSnapshots(snapshotWrites, config, tsconfigMappings, timing);

	const sourceMapper = config.sourceMap
		? timing.profile("buildSourceMapper", () => buildSourceMapper(config, tsconfigMappings))
		: undefined;

	resolveTestFilePaths(result, sourceMapper);

	// Harvest whenever per-test coverage was collected, even if no test credited
	// anything (perTestCoverage is then undefined): every cumulative hit ran
	// outside a window, so the whole hit set is static.
	const shouldHarvestStatic =
		config.collectPerTestCoverage === true && coverageData !== undefined;
	const attribution =
		perTestCoverage !== undefined || shouldHarvestStatic
			? harvestAttribution(perTestCoverage ?? [], coverageData ?? {}, (testFilePath) => {
					return resolveTestFileHash(sourceMapper, testFilePath);
				})
			: undefined;

	return { attribution, sourceMapper, writeCounts };
}

function buildResultTiming(
	{ result, setupMs }: ProjectBackendResult,
	{ backendTiming, startTime }: ProcessProjectOptions,
): TimingResult {
	return {
		executionMs: backendTiming.executionMs,
		setupMs,
		startTime,
		testsMs: calculateTestsMs(result.testResults),
		totalMs: Date.now() - startTime,
		uploadMs: backendTiming.uploadMs,
	};
}

function renderProjectOutput(
	{ result }: ProjectBackendResult,
	{ config, deferFormatting, version }: ProcessProjectOptions,
	timing: TimingResult,
	{ sourceMapper, writeCounts }: ProjectArtifacts,
): string {
	if (deferFormatting === true) {
		return "";
	}

	return formatExecuteOutput({
		config,
		result,
		snapshotWriteFailures: writeCounts.failed,
		sourceMapper,
		timing,
		version,
	});
}

/**
 * Process a single `ProjectBackendResult` into an `ExecuteResult`: writes
 * snapshots, builds the source mapper, resolves test-file paths, and renders
 * formatter output. Called once per job.
 */
function processProjectResult(
	backendResult: ProjectBackendResult,
	options: ProcessProjectOptions,
): ExecuteResult {
	const { config, timing } = options;
	const { luauTiming, result } = backendResult;

	const tsconfigMappings = timing.profile("resolveTsconfigMappings", () => {
		return resolveAllTsconfigMappings(config.rootDir, options.tsconfigCache);
	});

	const artifacts = collectProjectArtifacts(backendResult, options, tsconfigMappings);
	const resultTiming = buildResultTiming(backendResult, options);
	const output = renderProjectOutput(backendResult, options, resultTiming, artifacts);

	// Workspace runs (deferFormatting) surface these phases as nested
	// `luau.*` spans in the collector tree instead; the flat print would
	// duplicate them unindented above it, once per project.
	if (luauTiming !== undefined && options.deferFormatting !== true) {
		printLuauTiming(luauTiming);
	}

	const { failed } = artifacts.writeCounts;

	return {
		attribution: artifacts.attribution,
		coverageData: backendResult.coverageData,
		exitCode: failed === 0 && result.success ? 0 : 1,
		gameOutput: backendResult.gameOutput,
		gameOutputScope: backendResult.gameOutputScope,
		output,
		result,
		snapshotWriteFailures: failed > 0 ? failed : undefined,
		sourceMapper: artifacts.sourceMapper,
		timing: resultTiming,
	};
}

function processOrRecoverEntry(
	raw: RawBackendEntry,
	job: ProjectJob,
	context: EntryContext,
): ExecuteResult {
	// When one entry's envelope decodes to `{success:false,
	// err:...}` (Jest's per-entry pcall in `runEntry` encodes deferred
	// Promise rejections this way — e.g. when jest-core's runJest:345
	// calls exit(1) because a project's --testPathPattern matched zero
	// files), parseJestOutput throws LuauScriptError. Without per-entry
	// recovery the throw escapes runProjects entirely and the
	// workspace-runner never reaches writePerPackageOutputFiles or writes
	// snapshots from sibling entries. Convert the parse failure into a
	// synthetic failed ExecuteResult so the other entries' snapshot
	// writes and per-package output files still land.
	try {
		const projectResult = buildProjectResult(
			raw.entry,
			job,
			raw.fallbackGameOutput,
			raw.gameOutputScope,
		);
		return processProjectResult(projectResult, { ...context, config: job.config });
	} catch (err) {
		if (!(err instanceof LuauScriptError)) {
			throw err;
		}

		return buildExecutionErrorResult({
			backendTiming: context.backendTiming,
			config: job.config,
			deferFormatting: context.deferFormatting,
			error: err,
			startTime: context.startTime,
			version: context.version,
		});
	}
}
