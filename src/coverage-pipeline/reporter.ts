import { type } from "arktype";
import type istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import assert from "node:assert";
import process from "node:process";
import color from "tinyrainbow";

import { isCoverageReporter } from "../config/option-values.ts";
import type { CoverageReporter } from "../config/schema.ts";
import { type CoverageDisplayPredicate, narrowMappedForAgentTable } from "./agent-table-filter.ts";
import { filterCoverageUniverse } from "./coverage-universe.ts";
import { buildCoverageMap } from "./istanbul-coverage-map.ts";
import type { MappedCoverageResult } from "./mapper-types.ts";
import { createReporter } from "./reporter-registry.ts";

/** Inputs of {@link generateReports}. */
export interface CoverageReportOptions {
	/** Use the flat summarizer and agent-only output. */
	agentMode?: boolean | undefined;
	/**
	 * Display-only narrowing for the agent **text table** on a filtered run
	 * (single file / `--testPathPattern` / `--project`). Keeps just the matched
	 * source files in the per-file table; the totals line, thresholds, and the
	 * lcov/html/json reporters always report the full universe. Ignored outside
	 * agent mode and on a full run (`undefined`).
	 */
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	/** Include globs that bound the reported universe. */
	collectCoverageFrom?: Array<string> | undefined;
	/** Directory the file reporters write into. */
	coverageDirectory: string;
	/** Ignore globs that bound the reported universe. */
	coveragePathIgnorePatterns?: Array<string> | undefined;
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

/**
 * Metric order is the reported order of threshold failures — statements first,
 * lines last — so it is a fixed list rather than `Object.keys(thresholds)`.
 */
const THRESHOLD_METRICS = ["statements", "functions", "branches", "lines"] as const;

type CoverageMap = ReturnType<typeof istanbulCoverage.createCoverageMap>;
type CoverageSummaryData = typeof summarySchema.infer;

/**
 * Print the coverage report header to stdout.
 * @param agentMode - Print it without colors.
 */
export function printCoverageHeader(agentMode = false): void {
	const header = agentMode
		? " % Coverage report from istanbul"
		: ` ${color.blue("%")} ${color.dim("Coverage report from")} ${color.yellow("istanbul")}`;
	process.stdout.write(`\n${header}\n`);
}

const TEXT_REPORTERS: ReadonlySet<string> = new Set(["text", "text-summary"]);

interface TextTableView {
	context: ReturnType<typeof istanbulReport.createContext>;
	/**
	 * The filter matched no universe file — skip the `text` reporter entirely.
	 */
	isEmpty: boolean;
}

/**
 * Run the configured reporters over the coverage universe.
 * @param options - Mapped coverage, universe globs, reporters and output
 *   directory.
 * @throws {Error} When a reporter name is unknown.
 */
export function generateReports(options: CoverageReportOptions): void {
	const filtered = filterCoverageUniverse(options.mapped, {
		ignore: options.coveragePathIgnorePatterns,
		include: options.collectCoverageFrom,
	});
	const coverageMap = buildCoverageMap(filtered);

	const isAgentMode = options.agentMode === true;
	const defaultSummarizer = isAgentMode ? "flat" : "pkg";
	const createContext = options.createContext ?? istanbulReport.createContext;
	const context = createContext({
		coverageMap,
		defaultSummarizer,
		dir: options.coverageDirectory,
	});

	// On a filtered agent run the per-file `text` table narrows to the matched
	// source files — the full 200-row universe is noise for an agent inspecting
	// one file. Only the `text` reporter is narrowed: `text-summary`, lcov, html,
	// json, the totals line, and threshold checks all keep `coverageMap` (the
	// gate view).
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
	collectCoverageFrom,
	coveragePathIgnorePatterns,
	mapped,
	thresholds,
}: {
	/** Include globs that bound the universe. */
	collectCoverageFrom?: Array<string> | undefined;
	/** Ignore globs that bound the universe. */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/** Coverage mapped onto source files. */
	mapped: MappedCoverageResult;
	/** Minimum percentage per metric. */
	thresholds: { branches?: number; functions?: number; lines?: number; statements?: number };
}): ThresholdResult {
	const filtered = filterCoverageUniverse(mapped, {
		ignore: coveragePathIgnorePatterns,
		include: collectCoverageFrom,
	});
	const coverageMap = buildCoverageMap(filtered);
	const summary = coverageMap.getCoverageSummary();

	const summaryData = summarySchema(summary.toJSON());
	assert(!(summaryData instanceof type.errors));

	const failures = collectThresholdFailures(summaryData, thresholds);

	return {
		failures,
		passed: failures.length === 0,
	};
}

/**
 * Picks the context the `text` reporter renders against. With a filter present
 * (agent + filtered run) it narrows to the matched source files, layered on
 * `filtered`; otherwise it falls back to the full-universe context. The
 * narrowing never reaches `text-summary`, the other reporters, the totals line,
 * or the threshold path — all of those keep the full universe.
 * @param options - Filter, output directory, context factory, summarizer,
 *   fallback context and filtered coverage.
 * @returns Context for the `text` reporter and whether it matched nothing.
 */
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

/**
 * Runs each configured reporter against its context. The `text` reporter
 * renders against the (possibly narrowed) `textTable` context; every other
 * reporter uses the full-universe `fullContext`. A fully-covered agent run skips
 * the text reporters (the compact summary already printed); an empty narrowed
 * table skips `text` so only the totals line prints.
 * @param options - Reporters, contexts, agent flags and terminal width.
 * @throws {Error} When a reporter name is unknown.
 */
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
			// The declared element type makes this branch `never`, but the value
			// reaches here from user config, so the name is formatted through a
			// `string` parameter.
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

function printCompactFullSummary(coverageMap: CoverageMap): void {
	const fileCount = coverageMap.files().length;
	const label = fileCount === 1 ? "file" : "files";
	process.stdout.write(`Coverage: 100% (${fileCount} ${label})\n`);
}

function formatTotalsPart(label: string, totals: istanbulCoverage.Totals): string {
	return `${totals.pct}% ${label} (${totals.covered}/${totals.total})`;
}

function formatAgentTotals(coverageMap: CoverageMap): string {
	const summary = coverageMap.getCoverageSummary();
	const parts = [
		formatTotalsPart("stmts", summary.statements),
		formatTotalsPart("branch", summary.branches),
		formatTotalsPart("funcs", summary.functions),
		formatTotalsPart("lines", summary.lines),
	];

	return `Coverage: ${parts.join(" | ")}\n`;
}

function getTerminalColumns(): number | undefined {
	// oxlint-disable-next-line typescript/no-unnecessary-condition -- some environments might not have this property
	if (process.stdout.columns !== undefined) {
		return process.stdout.columns;
	}

	const parsed = Number(process.env["COLUMNS"]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isAllFilesFull(coverageMap: CoverageMap): boolean {
	const files = coverageMap.files();
	if (files.length === 0) {
		return false;
	}

	return files.every((file) => {
		const summary = coverageMap.fileCoverageFor(file).toSummary();
		// Istanbul derives line coverage from statement hits, so full statement
		// coverage already guarantees full line coverage.
		return (
			summary.statements.pct === 100 &&
			summary.branches.pct === 100 &&
			summary.functions.pct === 100
		);
	});
}

/**
 * Render the configured reporters plus the two agent-only extras that bracket
 * them: the compact one-liner a fully-covered run collapses to, and the totals
 * line that tells an agent how much `skipFull` hid.
 * @param options - Coverage map, contexts, agent flag and reporters.
 */
function emitReports({
	coverageMap,
	fullContext,
	isAgentMode,
	options: { createReporter: create = createReporter, reporters },
	textTable,
}: {
	coverageMap: CoverageMap;
	fullContext: ReturnType<typeof istanbulReport.createContext>;
	isAgentMode: boolean;
	options: Pick<CoverageReportOptions, "createReporter" | "reporters">;
	textTable: TextTableView;
}): void {
	const terminalColumns = getTerminalColumns();
	const hasTextReporter = reporters.some((name) => TEXT_REPORTERS.has(name));
	const areAllFilesFull = isAgentMode && isAllFilesFull(coverageMap);

	// Fully-covered runs collapse the text table to a single line; print it once
	// rather than per text reporter so configuring both text reporters can't
	// duplicate it.
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

	// skipFull leaves the table showing only sub-100% files; give the agent the
	// overall totals with raw counts so it knows exactly how much remains. An
	// empty map has nothing to total (Istanbul reports its pct as "Unknown"), so
	// skip it.
	if (isAgentMode && !areAllFilesFull && hasTextReporter && coverageMap.files().length > 0) {
		process.stdout.write(formatAgentTotals(coverageMap));
	}
}

/**
 * Collect the metrics whose measured percentage falls below a configured
 * threshold. A metric with no configured threshold, or whose summary pct is
 * Istanbul's non-numeric "Unknown", is skipped rather than failed.
 * @param summaryData - Validated coverage summary.
 * @param thresholds - Minimum percentage per metric.
 * @returns Failed metrics in reported order.
 */
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
