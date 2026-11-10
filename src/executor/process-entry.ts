import type { Except } from "type-fest";

import type { AttributionResult } from "../attribution/attribution.ts";
import { harvestAttribution } from "../attribution/attribution.ts";
import { createTestSourceResolver } from "../attribution/test-source.ts";
import { buildProjectResult } from "../backends/envelope.ts";
import type {
	BackendTiming,
	ProjectBackendResult,
	RawBackendEntry,
} from "../backends/interface.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { applyFailureGaps, applyGapRecord } from "../gaps/gaps.ts";
import { LuauScriptError } from "../jest-output/luau-script-error.ts";
import type { SnapshotWrites } from "../protocol/runner-fields.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type {
	TsconfigMapping,
	TsconfigMappingCache,
	TsconfigReader,
} from "../tsconfig/tsconfig-mappings.ts";
import { resolveAllTsconfigMappings } from "../tsconfig/tsconfig-mappings.ts";
import type { TimingResult } from "../types/timing-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildExecutionErrorResult } from "./exec-error.ts";
import type { ConfiguredJob, ExecuteResult } from "./executor-types.ts";
import { buildProjectSourceMap, resolveTestFilePaths } from "./project-source-map.ts";
import { writeSnapshots } from "./snapshot-writer.ts";
import { calculateTestsMs } from "./timing-spans.ts";

/** Post-processing context for a raw backend entry, minus its config. */
export type EntryContext = Except<ProcessProjectOptions, "config">;

interface ProcessProjectOptions {
	backendTiming: BackendTiming;
	config: ResolvedConfig;
	fileSystem: FileSystem;
	startTime: number;
	timing: TimingCollector;
	tsconfigCache: TsconfigMappingCache;
	tsconfigReader: TsconfigReader;
}

interface ProjectArtifacts {
	attribution: AttributionResult | undefined;
	snapshotWriteFailures: number;
	sourceMapper: SourceMapper | undefined;
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
	job: ConfiguredJob;
	raw: RawBackendEntry;
}): ExecuteResult {
	try {
		const projectResult = buildProjectResult({
			...raw.entry,
			fallbackGameOutput: raw.fallbackGameOutput,
			gameOutputScope: raw.gameOutputScope,
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
}): number {
	if (snapshotWrites === undefined) {
		return 0;
	}

	return timing.profile("writeSnapshots", () => {
		return writeSnapshots({ config, fileSystem, snapshotWrites, tsconfigMappings });
	});
}

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
	const snapshotWriteFailures = writeProjectSnapshots({
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
	// After the harvest: the resolver reads DataModel paths lazily during it.
	resolveTestFilePaths(result, sourceMap);

	return { attribution, snapshotWriteFailures, sourceMapper };
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

function processProjectResult(
	backendResult: ProjectBackendResult,
	options: ProcessProjectOptions,
): ExecuteResult {
	const { result } = backendResult;

	const tsconfigMappings = resolveProjectTsconfigMappings(options);
	const artifacts = collectProjectArtifacts({ ...backendResult, options, tsconfigMappings });
	const resultTiming = buildResultTiming(backendResult, options);
	const failed = artifacts.snapshotWriteFailures;

	return {
		attribution: artifacts.attribution,
		coverageData: backendResult.coverageData,
		exitCode: failed === 0 && result.success ? 0 : 1,
		gameOutput: backendResult.gameOutput,
		gameOutputScope: backendResult.gameOutputScope,
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
	job: ConfiguredJob;
	raw: RawBackendEntry;
}): ExecuteResult {
	const failed = buildExecutionErrorResult({
		backendTiming: context.backendTiming,
		entry: {
			pkg: job.pkg,
			project: job.displayName,
			testFileCount: job.testFiles.length,
		},
		error,
		startTime: context.startTime,
	});
	if (raw.gaps !== undefined) {
		applyFailureGaps(failed.result, raw.gaps);
	}

	return failed;
}
