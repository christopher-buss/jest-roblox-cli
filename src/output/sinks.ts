import * as path from "node:path";
import process from "node:process";

import type { ExecuteResult } from "../executor/executor-types.ts";
import {
	formatAnnotations,
	formatJobSummary,
	resolveGitHubActions,
} from "../formatters/github-actions.ts";
import { formatJson, writeJsonFileAsync } from "../formatters/json.ts";
import { findGitHubActionsOptions, usesAgentFormatter } from "../config/formatter-selection.ts";

import { mergeResults } from "../types/jest-result-merge.ts";
import type {
	OutputSettings,
	ProjectResult,
	SinkUnit,
	UnitTypecheckResult,
} from "../results/run-result-types.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { PackageGameOutput } from "../types/game-output-types.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	buildBatchGameOutput,
	buildGroupedGameOutput,
	countGroupedEntries,
	formatGameOutputNotice,
	parseGameOutput,
	writeGameOutput,
	writeGroupedGameOutput,
} from "../game-output/game-output.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";

const PER_UNIT_OUTPUT_DIRECTORY = path.join(WORK_DIRECTORY, "output");
const FILESYSTEM_UNSAFE = /[^\w@.-]+/g;

/** What every sink of a run is written from. */
export interface RunSinks {
	/** Where the sinks are written. */
	fileSystem: FileSystem;
	/** Type Test and runtime results merged. */
	mergedResult: JestResult;
	/** Per-project results in run order. */
	projectResults: Array<ProjectResult>;
	/** The projects' results merged; absent when no runtime job ran. */
	runtime: ExecuteResult | undefined;
	/** Resolved sink settings. */
	settings: OutputSettings;
	/** Type Test result of each (package, project) pair. */
	typecheckUnits: Array<UnitTypecheckResult>;
}

interface UnitResult extends SinkUnit {
	result: JestResult;
}

/**
 * Every file a run leaves behind: the result JSON, the per-package result
 * files, Game Output, and the GitHub Actions annotations.
 * @param sinks - Results and settings of the run.
 * @returns Resolves when every sink is written.
 */
export async function writeRunSinksAsync(sinks: RunSinks): Promise<void> {
	const { fileSystem, settings } = sinks;
	if (settings.outputFile !== undefined) {
		await writeJsonFileAsync({
			filePath: settings.outputFile,
			fileSystem,
			result: sinks.mergedResult,
			rootDir: settings.rootDir,
		});
	}

	if (settings.perUnitOutputFile) {
		writePerUnitResultFiles(sinks);
	}

	if (sinks.runtime !== undefined) {
		writeGameOutputSinks(sinks);
	}

	runGitHubActionsFormatter({
		fileSystem,
		result: sinks.mergedResult,
		settings,
		sourceMapper: sinks.runtime?.sourceMapper,
	});
}

function runGitHubActionsFormatter({
	fileSystem,
	result,
	settings,
	sourceMapper,
}: {
	fileSystem: FileSystem;
	result: JestResult;
	settings: OutputSettings;
	sourceMapper: SourceMapper | undefined;
}): void {
	const userOptions = findGitHubActionsOptions(settings.formatters);
	if (userOptions === undefined) {
		return;
	}

	const { annotations, context, jobSummaryPath } = resolveGitHubActions({
		sourceMapper,
		userOptions,
	});

	if (annotations) {
		const commands = formatAnnotations(result, context);
		if (commands !== "") {
			process.stderr.write(`${commands}\n`);
		}
	}

	if (jobSummaryPath !== undefined) {
		fileSystem.appendFileSync(jobSummaryPath, formatJobSummary(result, context));
	}
}

function unitKey({ pkg, project }: SinkUnit): string {
	return JSON.stringify([pkg, project]);
}

function sanitizePathSegment(segment: string): string {
	return segment.replace(FILESYSTEM_UNSAFE, "-");
}

function perUnitPath(rootDir: string, unit: SinkUnit, suffix: string): string {
	const filename = `${sanitizePathSegment(unit.pkg)}--${sanitizePathSegment(unit.project)}${suffix}`;
	return path.join(rootDir, PER_UNIT_OUTPUT_DIRECTORY, filename);
}

function collectUnitResults(
	projectResults: Array<ProjectResult>,
	typecheckUnits: Array<UnitTypecheckResult>,
): Array<UnitResult> {
	const byKey = new Map<string, UnitResult>();
	for (const { result, unit } of projectResults) {
		if (unit !== undefined) {
			byKey.set(unitKey(unit), { ...unit, result: result.result });
		}
	}

	for (const unit of typecheckUnits) {
		const key = unitKey(unit);
		byKey.set(key, {
			pkg: unit.pkg,
			project: unit.project,
			result: mergeResults(unit.result, byKey.get(key)?.result),
		});
	}

	return [...byKey.values()];
}

function writePerUnitResultFiles({
	fileSystem,
	projectResults,
	settings: { rootDir },
	typecheckUnits,
}: RunSinks): void {
	fileSystem.mkdirSync(path.join(rootDir, PER_UNIT_OUTPUT_DIRECTORY), { recursive: true });
	for (const entry of collectUnitResults(projectResults, typecheckUnits)) {
		fileSystem.writeFileSync(
			perUnitPath(rootDir, entry, ".jest-output.log"),
			formatJson(entry.result, rootDir),
			"utf8",
		);
	}
}

function buildAggregatedGroups(projectResults: Array<ProjectResult>): Array<PackageGameOutput> {
	const batched = projectResults.find((entry) => entry.result.gameOutputScope === "batch");
	if (batched !== undefined) {
		return buildBatchGameOutput(batched.result.gameOutput);
	}

	return buildGroupedGameOutput(
		projectResults.map(({ displayName, result, unit }) => {
			return unit === undefined
				? { project: displayName, raw: result.gameOutput }
				: { package: unit.pkg, project: unit.project, raw: result.gameOutput };
		}),
	);
}

function writeAggregatedGameOutput(
	{ fileSystem, projectResults }: RunSinks,
	filePath: string,
): string {
	const groups = buildAggregatedGroups(projectResults);
	writeGroupedGameOutput({ filePath, fileSystem, groups });
	return formatGameOutputNotice(filePath, countGroupedEntries(groups));
}

function writePerUnitGameOutput({ fileSystem, projectResults, settings }: RunSinks): Array<string> {
	return projectResults.flatMap(({ result, unit }) => {
		if (unit === undefined) {
			return [];
		}

		const filePath = perUnitPath(settings.rootDir, unit, ".game-output.log");
		const entries = parseGameOutput(result.gameOutput);
		writeGameOutput({ entries, filePath, fileSystem });
		const notice = formatGameOutputNotice(filePath, entries.length);
		return notice === "" ? [] : [notice];
	});
}

function writeGameOutputSinks(sinks: RunSinks): void {
	const { mergedResult, settings } = sinks;
	const aggregateNotice =
		settings.gameOutput === undefined
			? undefined
			: writeAggregatedGameOutput(sinks, settings.gameOutput);
	const perUnitNotices = settings.perUnitGameOutput ? writePerUnitGameOutput(sinks) : undefined;

	if (settings.silent) {
		return;
	}

	if (
		perUnitNotices !== undefined &&
		(aggregateNotice === undefined || usesAgentFormatter(settings))
	) {
		for (const notice of perUnitNotices) {
			console.error(notice);
		}
	} else if (aggregateNotice !== undefined && aggregateNotice !== "" && mergedResult.success) {
		console.error(aggregateNotice);
	}
}
