import { type } from "arktype";
import istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import istanbulReports from "istanbul-reports";
import assert from "node:assert";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { CoverageReporter } from "../config/schema.ts";
import { isCoverageReporter } from "../config/schema.ts";
import { type CoverageDisplayPredicate, narrowMappedForAgentTable } from "./agent-table-filter.ts";
import { filterCoverageUniverse } from "./coverage-universe.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./mapper.ts";

export interface CoverageReportOptions {
	agentMode?: boolean | undefined;
	/**
	 * Display-only narrowing for the agent **text table** on a filtered run
	 * (single file / `--testPathPattern` / `--project`). Keeps just the matched
	 * source files in the per-file table; the totals line, thresholds, and the
	 * lcov/html/json reporters always report the full universe. Ignored outside
	 * agent mode and on a full run (`undefined`).
	 */
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	collectCoverageFrom?: Array<string> | undefined;
	coverageDirectory: string;
	coveragePathIgnorePatterns?: Array<string> | undefined;
	mapped: MappedCoverageResult;
	reporters: Array<CoverageReporter>;
}

export interface ThresholdResult {
	failures: Array<{ actual: number; metric: string; threshold: number }>;
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

type FileCoverageData = istanbulCoverage.FileCoverageData;
type CoverageMap = ReturnType<typeof istanbulCoverage.createCoverageMap>;
type CoverageSummaryData = typeof summarySchema.infer;

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

export function generateReports(options: CoverageReportOptions): void {
	const filtered = filterCoverageUniverse(options.mapped, {
		ignore: options.coveragePathIgnorePatterns,
		include: options.collectCoverageFrom,
	});
	const coverageMap = buildCoverageMap(filtered);

	const isAgentMode = options.agentMode === true;
	const defaultSummarizer = isAgentMode ? "flat" : "pkg";
	const context = istanbulReport.createContext({
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
		defaultSummarizer,
		fallback: context,
		filtered,
	});

	emitReports({
		coverageMap,
		fullContext: context,
		isAgentMode,
		reporters: options.reporters,
		textTable,
	});
}

export function checkThresholds(
	mapped: MappedCoverageResult,
	thresholds: { branches?: number; functions?: number; lines?: number; statements?: number },
	collectCoverageFrom?: Array<string>,
	coveragePathIgnorePatterns?: Array<string>,
): ThresholdResult {
	const filtered = filterCoverageUniverse(mapped, {
		ignore: coveragePathIgnorePatterns,
		include: collectCoverageFrom,
	});
	const coverageMap = buildCoverageMap(filtered);
	const summary = coverageMap.getCoverageSummary();

	const summaryData = summarySchema(summary.toJSON());
	assert(!(summaryData instanceof type.errors), "Istanbul summary produced invalid data");

	const failures = collectThresholdFailures(summaryData, thresholds);

	return {
		failures,
		passed: failures.length === 0,
	};
}

/** Restate our branch entries in Istanbul's shape (it also wants `line`). */
function toIstanbulBranchMap(
	branchMap: MappedFileCoverage["branchMap"],
): FileCoverageData["branchMap"] {
	return Object.fromEntries(
		Object.entries(branchMap).map(([id, entry]) => {
			return [
				id,
				{
					line: entry.loc.start.line,
					loc: entry.loc,
					locations: entry.locations,
					type: entry.type,
				},
			];
		}),
	);
}

/** Restate our function entries in Istanbul's shape (it also wants `decl`). */
function toIstanbulFuncMap(funcMap: MappedFileCoverage["fnMap"]): FileCoverageData["fnMap"] {
	return Object.fromEntries(
		Object.entries(funcMap).map(([id, entry]) => {
			return [
				id,
				{
					name: entry.name,
					decl: entry.loc,
					line: entry.loc.start.line,
					loc: entry.loc,
				},
			];
		}),
	);
}

function buildCoverageMap(mapped: MappedCoverageResult): CoverageMap {
	const coverageMap = istanbulCoverage.createCoverageMap({});

	for (const [filePath, fileCoverage] of Object.entries(mapped.files)) {
		const fileCoverageData = {
			b: fileCoverage.b,
			branchMap: toIstanbulBranchMap(fileCoverage.branchMap),
			f: fileCoverage.f,
			fnMap: toIstanbulFuncMap(fileCoverage.fnMap),
			path: path.resolve(filePath),
			s: fileCoverage.s,
			statementMap: fileCoverage.statementMap,
		} satisfies FileCoverageData;
		coverageMap.addFileCoverage(fileCoverageData);
	}

	return coverageMap;
}

// Picks the context the `text` reporter renders against. With a filter present
// (agent + filtered run) it narrows to the matched source files, layered on
// `filtered`; otherwise it falls back to the full-universe context. The
// narrowing never reaches `text-summary`, the other reporters, the totals line,
// or the threshold path — all of those keep the full universe.
function resolveTextTableView({
	agentTextFilter,
	coverageDirectory,
	defaultSummarizer,
	fallback,
	filtered,
}: {
	agentTextFilter: CoverageDisplayPredicate | undefined;
	coverageDirectory: string;
	defaultSummarizer: "flat" | "pkg";
	fallback: ReturnType<typeof istanbulReport.createContext>;
	filtered: MappedCoverageResult;
}): TextTableView {
	if (agentTextFilter === undefined) {
		return { context: fallback, isEmpty: false };
	}

	const textCoverageMap = buildCoverageMap(narrowMappedForAgentTable(filtered, agentTextFilter));
	const context = istanbulReport.createContext({
		coverageMap: textCoverageMap,
		defaultSummarizer,
		dir: coverageDirectory,
	});

	return { context, isEmpty: textCoverageMap.files().length === 0 };
}

function unknownReporterError(name: string): Error {
	return new Error(`Unknown coverage reporter: ${name}`);
}

// Runs each configured reporter against its context. The `text` reporter renders
// against the (possibly narrowed) `textTable` context; every other reporter uses
// the full-universe `fullContext`. A fully-covered agent run skips the text
// reporters (the compact summary already printed); an empty narrowed table skips
// `text` so only the totals line prints.
function runReporters({
	agentMode,
	allFilesFull,
	fullContext,
	reporters,
	terminalColumns,
	textTable,
}: {
	agentMode: boolean;
	allFilesFull: boolean;
	fullContext: ReturnType<typeof istanbulReport.createContext>;
	reporters: Array<CoverageReporter>;
	terminalColumns: number | undefined;
	textTable: TextTableView;
}): void {
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

		let reporterOptions = {};
		if (reporterName === "text") {
			reporterOptions = { maxCols: terminalColumns, skipFull: agentMode };
		} else if (TEXT_REPORTERS.has(reporterName)) {
			reporterOptions = { skipFull: agentMode };
		}

		const report = istanbulReports.create(reporterName, reporterOptions);
		report.execute(reporterName === "text" ? textTable.context : fullContext);
	}
}

function printCompactFullSummary(coverageMap: CoverageMap): void {
	const fileCount = coverageMap.files().length;
	const label = fileCount === 1 ? "file" : "files";
	process.stdout.write(`Coverage: 100% (${fileCount} ${label})\n`);
}

function formatTotalsPart(label: string, totals: istanbulCoverage.Totals): string {
	// Istanbul's blank summary (empty map) sets pct to the string "Unknown"
	// despite the numeric type. Callers guard against the empty map, so fail
	// loudly if a non-numeric pct ever slips through instead of printing garbage.
	assert(typeof totals.pct === "number", "coverage summary pct must be numeric");
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
	// eslint-disable-next-line ts/no-unnecessary-condition -- some environments might not have this property
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
 */
function emitReports({
	coverageMap,
	fullContext,
	isAgentMode,
	reporters,
	textTable,
}: {
	coverageMap: CoverageMap;
	fullContext: ReturnType<typeof istanbulReport.createContext>;
	isAgentMode: boolean;
	reporters: Array<CoverageReporter>;
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
