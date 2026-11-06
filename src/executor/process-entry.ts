import type { Except } from "type-fest";

import { buildProjectResult } from "../backends/envelope.ts";
import type {
	BackendTiming,
	ProjectBackendResult,
	ProjectJob,
	RawBackendEntry,
} from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { AttributionResult } from "../coverage-pipeline/attribution.ts";
import { harvestAttribution } from "../coverage-pipeline/attribution.ts";
import { createTestSourceResolver } from "../coverage-pipeline/test-source.ts";
import { LuauScriptError } from "../reporter/luau-script-error.ts";
import type { SnapshotWrites } from "../reporter/parser.ts";
import { applyFailureGaps, applyGapRecord } from "../results/gaps.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TimingResult } from "../types/timing-types.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildExecutionErrorResult } from "./exec-error.ts";
import type { ExecuteResult } from "./executor-types.ts";
import { formatExecuteOutput } from "./format-output.ts";
import { buildProjectSourceMap, resolveTestFilePaths } from "./project-source-map.ts";
import type { SnapshotWriteCounts } from "./snapshot-writer.ts";
import { writeSnapshots } from "./snapshot-writer.ts";
import { calculateTestsMs, printLuauTiming } from "./timing-spans.ts";
import type { TsconfigMappingCache, TsconfigReader } from "./tsconfig-mappings.ts";
import { resolveAllTsconfigMappings } from "./tsconfig-mappings.ts";

/**
 * Everything a raw backend entry needs to post-process except the config,
 * which each entry recovers from its own job.
 */
export type EntryContext = Except<ProcessProjectOptions, "config">;

interface ProcessProjectOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	deferFormatting?: boolean | undefined;
	fileSystem: FileSystem;
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
	tsconfigReader: TsconfigReader;
	version: string;
}

interface ProjectArtifacts {
	attribution: AttributionResult | undefined;
	sourceMapper: SourceMapper | undefined;
	writeCounts: SnapshotWriteCounts;
}

/**
 * Process one backend entry into an `ExecuteResult`. A Luau script failure
 * becomes a failed exec-error result instead of a throw.
 * @param options - The shared context, the job and its raw backend entry.
 * @returns The processed or recovered result.
 * @throws Any error other than a `LuauScriptError`.
 */
export function processOrRecoverEntry({
	context,
	job,
	raw,
}: {
	context: EntryContext;
	job: ProjectJob;
	raw: RawBackendEntry;
}): ExecuteResult {
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
		const projectResult = buildProjectResult({
			...raw.entry,
			fallbackGameOutput: raw.fallbackGameOutput,
			gameOutputScope: raw.gameOutputScope,
			job,
		});
		if (raw.gaps !== undefined) {
			applyGapRecord(projectResult.result, raw.gaps);
		}

		return processProjectResult(projectResult, { ...context, config: job.config });
	} catch (err) {
		if (!(err instanceof LuauScriptError)) {
			throw err;
		}

		return recoverFromParseFailure({ context, error: err, job, raw });
	}
}

function writeProjectSnapshots({
	config,
	fileSystem,
	snapshotWrites,
	timing,
	tsconfigMappings,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	snapshotWrites: SnapshotWrites | undefined;
	timing: TimingCollector;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}): SnapshotWriteCounts {
	if (snapshotWrites === undefined) {
		return { attempted: 0, failed: 0, written: 0 };
	}

	return timing.profile("writeSnapshots", () => {
		return writeSnapshots({ config, fileSystem, snapshotWrites, tsconfigMappings });
	});
}

/**
 * Everything the resolved tsconfig mappings unlock for one project: the
 * snapshot writes they address, the source mapper they feed, and the
 * attribution keyed off that mapper. The mapper is returned alongside the
 * attribution because the caller threads it into both the formatter and the
 * `ExecuteResult`.
 *
 * @param options - The backend result, process options and tsconfig mappings.
 * @returns Snapshot write counts, the source mapper and the attribution.
 */
function collectProjectArtifacts({
	coverageData,
	options: { config, fileSystem, timing },
	perTestCoverage,
	result,
	snapshotWrites,
	tsconfigMappings,
}: ProjectBackendResult & {
	options: ProcessProjectOptions;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}): ProjectArtifacts {
	const writeCounts = writeProjectSnapshots({
		config,
		fileSystem,
		snapshotWrites,
		timing,
		tsconfigMappings,
	});

	const sourceMap = config.sourceMap
		? timing.profile("buildSourceMapper", () => {
				return buildProjectSourceMap({ config, fileSystem, tsconfigMappings });
			})
		: undefined;
	const sourceMapper = sourceMap?.sourceMapper;

	const resolveTestSource = createTestSourceResolver({ fileSystem, result, sourceMapper });

	// Harvest whenever per-test coverage was collected, even if no test credited
	// anything (perTestCoverage is then undefined): every cumulative hit ran
	// outside a window, so the whole hit set is static.
	const shouldHarvestStatic =
		config.collectPerTestCoverage === true && coverageData !== undefined;
	const attribution =
		perTestCoverage !== undefined || shouldHarvestStatic
			? harvestAttribution({
					cumulative: coverageData ?? {},
					entries: perTestCoverage ?? [],
					resolveTestSource,
				})
			: undefined;
	// The resolver reads the DataModel paths lazily, during the harvest.
	resolveTestFilePaths(result, sourceMap);

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

function renderProjectOutput({
	artifacts: { sourceMapper, writeCounts },
	options: { config, deferFormatting, version },
	result,
	timing,
}: ProjectBackendResult & {
	artifacts: ProjectArtifacts;
	options: ProcessProjectOptions;
	timing: TimingResult;
}): string {
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
 * This project's tsconfig mappings, measured under the span the run reports.
 *
 * @param options - Process options of the project.
 * @returns The resolved mappings.
 */
function resolveProjectTsconfigMappings(options: ProcessProjectOptions): Array<TsconfigMapping> {
	return options.timing.profile("resolveTsconfigMappings", () => {
		return resolveAllTsconfigMappings({
			cache: options.tsconfigCache,
			fileSystem: options.fileSystem,
			projectRoot: options.config.rootDir,
			tsconfigReader: options.tsconfigReader,
		});
	});
}

/**
 * Process a single `ProjectBackendResult` into an `ExecuteResult`: writes
 * snapshots, builds the source mapper, resolves test-file paths, and renders
 * formatter output. Called once per job.
 *
 * @param backendResult - Parsed Jest output of one project.
 * @param options - Shared run context plus this job's config.
 * @returns Result, coverage, attribution and formatted output for the job.
 */
function processProjectResult(
	backendResult: ProjectBackendResult,
	options: ProcessProjectOptions,
): ExecuteResult {
	const { luauTiming, result } = backendResult;

	const tsconfigMappings = resolveProjectTsconfigMappings(options);
	const artifacts = collectProjectArtifacts({ ...backendResult, options, tsconfigMappings });
	const resultTiming = buildResultTiming(backendResult, options);
	const output = renderProjectOutput({
		...backendResult,
		artifacts,
		options,
		timing: resultTiming,
	});

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

function recoverFromParseFailure({
	context,
	error,
	job,
	raw,
}: {
	context: EntryContext;
	error: LuauScriptError;
	job: ProjectJob;
	raw: RawBackendEntry;
}): ExecuteResult {
	const failed = buildExecutionErrorResult({
		backendTiming: context.backendTiming,
		config: job.config,
		deferFormatting: context.deferFormatting,
		// Off the job rather than off the entry: the entry is what the run
		// came back with, and a run that came back with nothing still has
		// the job the host sent.
		entry: {
			pkg: job.pkg,
			project: job.displayName,
			testFileCount: job.testFiles.length,
		},
		error,
		startTime: context.startTime,
		version: context.version,
	});
	if (raw.gaps !== undefined) {
		applyFailureGaps(failed.result, raw.gaps);
	}

	return failed;
}
