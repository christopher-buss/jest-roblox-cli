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
import { applySnapshotFormatDefaults } from "./config/loader.ts";
import type { ResolvedConfig } from "./config/schema.ts";
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
import { isLuauProject, resolveAllTsconfigMappings } from "./executor/tsconfig-mappings.ts";
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
	version: string;
	workStealing?: boolean | undefined;
}

export interface RunProjectsResult {
	backendTiming: BackendTiming;
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
 * Unified orchestration entry point: builds jobs for every input project,
 * dispatches them through the backend in one call, shapes each raw envelope
 * entry into a `ProjectBackendResult`, then maps each through per-project
 * post-processing. Single-, multi-, and workspace-run callers all funnel
 * through here so the build→execute→shape→process sequence lives in
 * exactly one place.
 *
 * Ordering contract: the returned `results` array is in the same order as
 * `options.projects`. Backends MUST return `rawResults` in the same order
 * as the submitted `jobs` envelope — `runProjects` indexes into `jobs[i]`
 * to recover each project's resolved config and pair it with the matching
 * raw entry, so out-of-order results would post-process with the wrong
 * config.
 */
export async function runProjectsAsync(options: RunProjectsOptions): Promise<RunProjectsResult> {
	const timing = options.timing ?? NOOP_TIMING_COLLECTOR;
	const jobs = buildJobs(options.projects, timing);

	const { rawResults, timing: backendTiming } = await dispatchToBackendAsync(
		options,
		jobs,
		timing,
	);

	assertResultParity(rawResults.length, jobs.length);

	const context: EntryContext = {
		backendTiming,
		deferFormatting: options.deferFormatting,
		startTime: options.startTime,
		timing,
		version: options.version,
	};

	const results = timing.profile("processResults", () => {
		return rawResults.map((raw, index) => {
			// eslint-disable-next-line ts/no-non-null-assertion -- length equality asserted above
			const job = jobs[index]!;
			return processOrRecoverEntry(raw, job, context);
		});
	});

	return { backendTiming, results };
}

/**
 * Build a `ProjectJob` with `snapshotFormat` resolved per-project. Each job
 * carries its own config so the Luau runner never re-resolves or shares format
 * state across projects (fixes the spike's snapshot-diff regression — C1).
 */
function buildProjectJob(parameters: ProjectInput, timing: TimingCollector): ProjectJob {
	const tsconfigMappings = timing.profile("resolveTsconfigMappings", () => {
		return resolveAllTsconfigMappings(parameters.config.rootDir);
	});
	const isLuau = isLuauProject(parameters.testFiles, tsconfigMappings);
	const config = applySnapshotFormatDefaults(parameters.config, isLuau);
	return {
		config,
		displayColor: parameters.displayColor,
		displayName: parameters.displayName ?? "",
		pkg: parameters.pkg,
		runtimeInjectionPaths: parameters.runtimeInjectionPaths,
		testFiles: parameters.testFiles,
	};
}

function buildJobs(
	projects: ReadonlyArray<ProjectInput>,
	timing: TimingCollector,
): Array<ProjectJob> {
	return timing.profile("buildJobs", () => {
		return projects.map((project) => buildProjectJob(project, timing));
	});
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
			scriptFactory: options.scriptFactory,
			scriptOverride: options.scriptOverride,
			streaming: options.streaming,
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
		return resolveAllTsconfigMappings(config.rootDir);
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
		const projectResult = buildProjectResult(raw.entry, job, raw.fallbackGameOutput);
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
