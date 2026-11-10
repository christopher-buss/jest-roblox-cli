import process from "node:process";
import color from "tinyrainbow";

import type { CoverageDisplayPredicate } from "../coverage-report/agent-table-filter.ts";
import {
	checkThresholds,
	generateReports,
	printCoverageHeader,
} from "../coverage-report/reporter.ts";
import { usesAgentFormatter } from "../config/formatter-selection.ts";
import type {
	CoverageReportUnit,
	OutputSettings,
	RunCoverage,
} from "../results/run-result-types.ts";

/** The coverage steps {@link processCoverage} runs, injectable for tests. */
export interface CoveragePipeline {
	/** Judges a universe against a coverage threshold. */
	checkThresholds: typeof checkThresholds;
	/** Writes the configured coverage reports. */
	generateReports: typeof generateReports;
}

interface ProcessCoverageOptions {
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	coverage: RunCoverage | undefined;
	pipeline: CoveragePipeline;
	settings: Pick<OutputSettings, "formatters" | "silent" | "verbose">;
}

export const defaultCoveragePipeline: CoveragePipeline = {
	checkThresholds,
	generateReports,
};

/**
 * Write the coverage reports and judge each unit against its threshold.
 * @param options - Mapped coverage, settings and pipeline.
 * @returns False when any unit fails its threshold.
 */
export function processCoverage({
	agentTextFilter,
	coverage,
	pipeline,
	settings,
}: ProcessCoverageOptions): boolean {
	if (coverage === undefined) {
		return true;
	}

	if (coverage.notice !== undefined && !settings.silent) {
		process.stderr.write(`${coverage.notice}\n`);
	}

	const { units } = coverage;
	if (units.length === 0) {
		return true;
	}

	const isAgentMode = usesAgentFormatter(settings);
	if (!settings.silent) {
		printCoverageHeader(isAgentMode);
	}

	let isPassed = true;
	for (const unit of units) {
		if (unit.label !== undefined && !settings.silent) {
			process.stdout.write(`\n${unit.label}\n`);
		}

		pipeline.generateReports({
			agentMode: isAgentMode,
			agentTextFilter,
			coverageDirectory: unit.coverageDirectory,
			mapped: unit.universe,
			reporters: unit.reporters,
		});

		isPassed = enforceUnitThreshold(unit, pipeline.checkThresholds) && isPassed;
	}

	return isPassed;
}

/**
 * Write the closing PASS or FAIL badge to stdout.
 * @param passed - Whether the run passed.
 */
export function printFinalStatus(passed: boolean): void {
	const badge = passed
		? color.bgGreen(color.black(color.bold(" PASS ")))
		: color.bgRed(color.white(color.bold(" FAIL ")));
	process.stdout.write(`${badge}\n`);
}

function enforceUnitThreshold(
	unit: CoverageReportUnit,
	checkUnitThresholds: CoveragePipeline["checkThresholds"],
): boolean {
	if (unit.coverageThreshold === undefined) {
		return true;
	}

	const result = checkUnitThresholds({
		mapped: unit.universe,
		thresholds: unit.coverageThreshold,
	});
	if (result.passed) {
		return true;
	}

	const prefix = unit.label === undefined ? "" : `${unit.label} `;
	for (const failure of result.failures) {
		process.stderr.write(
			`Coverage threshold not met for ${prefix}${failure.metric}: ${failure.actual.toFixed(2)}% < ${String(failure.threshold)}%\n`,
		);
	}

	return false;
}
