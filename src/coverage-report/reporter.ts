import { type } from "arktype";
import type istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import assert from "node:assert";
import process from "node:process";
import color from "tinyrainbow";

import type { CoverageReporter } from "../config/config-types.ts";
import { isCoverageReporter } from "../config/option-values.ts";
import { plural } from "../terminal/plural.ts";
import { readTerminalColumns } from "../terminal/width.ts";
import { type CoverageDisplayPredicate, narrowMappedForAgentTable } from "./agent-table-filter.ts";
import { buildCoverageMap } from "./istanbul-coverage-map.ts";
import type { MappedCoverageResult } from "./mapper-types.ts";
import { createReporter } from "./reporter-registry.ts";

/** Inputs of {@link generateReports}. */
export interface CoverageReportOptions {
	/** Use the flat summarizer and agent-only output. */
	agentMode?: boolean | undefined;
	/** Agent-mode filter for the `text` table only. */
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	/** Directory the file reporters write into. */
	coverageDirectory: string;
	/** Istanbul context factory; defaults to istanbul's own. */
	createContext?: typeof istanbulReport.createContext | undefined;
	/** Reporter factory; defaults to the bundled registry. */
	createReporter?: typeof createReporter | undefined;
	/** Coverage mapped onto source files. */
	mapped: MappedCoverageResult;
	/** Reporters to run, in order. */
	reporters: Array<CoverageReporter>;
}

/** Outcome of {@link checkThresholds}. */
export interface ThresholdResult {
	/** Metrics below their threshold, in reported order. */
	failures: Array<{ actual: number; metric: string; threshold: number }>;
	/** No metric fell below its threshold. */
	passed: boolean;
}

const summarySchema = type({
	"[string]": { pct: "number | string" },
});

// Order is the reported order of threshold failures.
const THRESHOLD_METRICS = ["statements", "functions", "branches", "lines"] as const;

type CoverageSummaryData = typeof summarySchema.infer;

/**
 * Print the coverage report header to stdout.
 * @param agentMode - Print it without colors.
 */
export function printCoverageHeader(agentMode: boolean): void {
	const header = agentMode
		? " % Coverage report from istanbul"
		: ` ${color.blue("%")} ${color.dim("Coverage report from")} ${color.yellow("istanbul")}`;
	process.stdout.write(`\n${header}\n`);
}

const TEXT_REPORTERS: ReadonlySet<string> = new Set(["text", "text-summary"]);

interface TextTableView {
	context: ReturnType<typeof istanbulReport.createContext>;
	isEmpty: boolean;
}

/**
 * Run the configured reporters over the coverage universe.
 * @param options - Mapped coverage, universe globs, reporters and output
 *   directory.
 * @throws {Error} When a reporter name is unknown.
 */
export function generateReports(options: CoverageReportOptions): void {
	const filtered = options.mapped;
	const coverageMap = buildCoverageMap(filtered);

	const isAgentMode = options.agentMode === true;
	const defaultSummarizer = isAgentMode ? "flat" : "pkg";
	const createContext = options.createContext ?? istanbulReport.createContext;
	const context = createContext({
		coverageMap,
		defaultSummarizer,
		dir: options.coverageDirectory,
	});

	const textTable = resolveTextTableView({
		agentTextFilter: isAgentMode ? options.agentTextFilter : undefined,
		coverageDirectory: options.coverageDirectory,
		createContext,
		defaultSummarizer,
		fallback: context,
		filtered,
	});

	emitReports({
		coverageMap,
		fullContext: context,
		isAgentMode,
		options,
		textTable,
	});
}

/**
 * Compare the universe's coverage summary with the configured thresholds.
 * @param options - Mapped coverage, universe globs and thresholds.
 * @returns Failed metrics and whether all passed.
 */
export function checkThresholds({
	mapped,
	thresholds,
}: {
	/** Coverage mapped onto source files. */
	mapped: MappedCoverageResult;
	/** Minimum percentage per metric. */
	thresholds: { branches?: number; functions?: number; lines?: number; statements?: number };
}): ThresholdResult {
	const coverageMap = buildCoverageMap(mapped);
	const summary = coverageMap.getCoverageSummary();

	const summaryData = summarySchema(summary.toJSON());
	assert(!(summaryData instanceof type.errors));

	const failures = collectThresholdFailures(summaryData, thresholds);

	return {
		failures,
		passed: failures.length === 0,
	};
}

function resolveTextTableView({
	agentTextFilter,
	coverageDirectory,
	createContext,
	defaultSummarizer,
	fallback,
	filtered,
}: {
	agentTextFilter: CoverageDisplayPredicate | undefined;
	coverageDirectory: string;
	createContext: typeof istanbulReport.createContext;
	defaultSummarizer: "flat" | "pkg";
	fallback: ReturnType<typeof istanbulReport.createContext>;
	filtered: MappedCoverageResult;
}): TextTableView {
	if (agentTextFilter === undefined) {
		return { context: fallback, isEmpty: false };
	}

	const textCoverageMap = buildCoverageMap(narrowMappedForAgentTable(filtered, agentTextFilter));
	const context = createContext({
		coverageMap: textCoverageMap,
		defaultSummarizer,
		dir: coverageDirectory,
	});

	return { context, isEmpty: textCoverageMap.files().length === 0 };
}

function unknownReporterError(name: string): Error {
	return new Error(`Unknown coverage reporter: ${name}`);
}

function runReporters({
	agentMode,
	allFilesFull,
	createReporter: create,
	fullContext,
	reporters,
	terminalColumns,
	textTable,
}: {
	agentMode: boolean;
	allFilesFull: boolean;
	createReporter: typeof createReporter;
	fullContext: ReturnType<typeof istanbulReport.createContext>;
	reporters: Array<CoverageReporter>;
	terminalColumns: number | undefined;
	textTable: TextTableView;
}): void {
	const optionsByReporter: Partial<Record<CoverageReporter, object>> = {
		text: { maxCols: terminalColumns, skipFull: agentMode },
	};
	for (const reporterName of reporters) {
		if (!isCoverageReporter(reporterName)) {
			// Reachable from user config despite the `never` type.
			throw unknownReporterError(reporterName);
		}

		if (allFilesFull && TEXT_REPORTERS.has(reporterName)) {
			continue;
		}

		if (reporterName === "text" && textTable.isEmpty) {
			continue;
		}

		const report = create(reporterName, optionsByReporter[reporterName] ?? {});
		report.execute(reporterName === "text" ? textTable.context : fullContext);
	}
}

function printCompactFullSummary(coverageMap: istanbulCoverage.CoverageMap): void {
	const fileCount = coverageMap.files().length;
	const label = plural(fileCount, "file");
	process.stdout.write(`Coverage: 100% (${fileCount} ${label})\n`);
}

function formatTotalsPart(label: string, totals: istanbulCoverage.Totals): string {
	return `${totals.pct}% ${label} (${totals.covered}/${totals.total})`;
}

function formatAgentTotals(coverageMap: istanbulCoverage.CoverageMap): string {
	const summary = coverageMap.getCoverageSummary();
	const parts = [
		formatTotalsPart("stmts", summary.statements),
		formatTotalsPart("branch", summary.branches),
		formatTotalsPart("funcs", summary.functions),
		formatTotalsPart("lines", summary.lines),
	];

	return `Coverage: ${parts.join(" | ")}\n`;
}

function isAllFilesFull(coverageMap: istanbulCoverage.CoverageMap): boolean {
	const files = coverageMap.files();
	if (files.length === 0) {
		return false;
	}

	return files.every((file) => {
		const summary = coverageMap.fileCoverageFor(file).toSummary();
		return (
			summary.statements.pct === 100 &&
			summary.branches.pct === 100 &&
			summary.functions.pct === 100
		);
	});
}

function emitReports({
	coverageMap,
	fullContext,
	isAgentMode,
	options: { createReporter: create = createReporter, reporters },
	textTable,
}: {
	coverageMap: istanbulCoverage.CoverageMap;
	fullContext: ReturnType<typeof istanbulReport.createContext>;
	isAgentMode: boolean;
	options: Pick<CoverageReportOptions, "createReporter" | "reporters">;
	textTable: TextTableView;
}): void {
	const terminalColumns = readTerminalColumns();
	const hasTextReporter = reporters.some((name) => TEXT_REPORTERS.has(name));
	const areAllFilesFull = isAgentMode && isAllFilesFull(coverageMap);

	if (areAllFilesFull && hasTextReporter) {
		printCompactFullSummary(coverageMap);
	}

	runReporters({
		agentMode: isAgentMode,
		allFilesFull: areAllFilesFull,
		createReporter: create,
		fullContext,
		reporters,
		terminalColumns,
		textTable,
	});

	if (isAgentMode && !areAllFilesFull && hasTextReporter && coverageMap.files().length > 0) {
		process.stdout.write(formatAgentTotals(coverageMap));
	}
}

function collectThresholdFailures(
	summaryData: CoverageSummaryData,
	thresholds: { branches?: number; functions?: number; lines?: number; statements?: number },
): ThresholdResult["failures"] {
	const failures: ThresholdResult["failures"] = [];

	for (const metric of THRESHOLD_METRICS) {
		const threshold = thresholds[metric];
		if (threshold === undefined) {
			continue;
		}

		const pct = summaryData[metric]?.pct;
		if (typeof pct !== "number") {
			continue;
		}

		if (pct < threshold) {
			failures.push({ actual: pct, metric, threshold });
		}
	}

	return failures;
}
