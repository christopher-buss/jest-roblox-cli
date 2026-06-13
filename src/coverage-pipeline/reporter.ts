import { type } from "arktype";
import istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import istanbulReports, { type ReportOptions } from "istanbul-reports";
import assert from "node:assert";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { CoverageReporter } from "../config/schema.ts";
import { filterCoverageUniverse } from "./coverage-universe.ts";
import type { MappedCoverageResult } from "./mapper.ts";

const VALID_REPORTERS: ReadonlySet<string> = new Set<CoverageReporter>([
	"clover",
	"cobertura",
	"html",
	"html-spa",
	"json",
	"json-summary",
	"lcov",
	"lcovonly",
	"none",
	"teamcity",
	"text",
	"text-lcov",
	"text-summary",
]);

export interface CoverageReportOptions {
	agentMode?: boolean;
	collectCoverageFrom?: Array<string>;
	coverageDirectory: string;
	coveragePathIgnorePatterns?: Array<string>;
	mapped: MappedCoverageResult;
	reporters: Array<CoverageReporter>;
}

export interface ThresholdResult {
	failures: Array<{ actual: number; metric: string; threshold: number }>;
	passed: boolean;
}

type FileCoverageData = istanbulCoverage.FileCoverageData;
type CoverageMap = ReturnType<typeof istanbulCoverage.createCoverageMap>;

export function printCoverageHeader(): void {
	const header = ` ${color.blue("%")} ${color.dim("Coverage report from")} ${color.yellow("istanbul")}`;
	process.stdout.write(`\n${header}\n`);
}

const TEXT_REPORTERS: ReadonlySet<string> = new Set(["text", "text-summary"]);

export function generateReports(options: CoverageReportOptions): void {
	const filtered = filterCoverageUniverse(options.mapped, {
		ignore: options.coveragePathIgnorePatterns,
		include: options.collectCoverageFrom,
	});
	const coverageMap = buildCoverageMap(filtered);

	const agentMode = options.agentMode === true;
	const context = istanbulReport.createContext({
		coverageMap,
		defaultSummarizer: agentMode ? "flat" : "pkg",
		dir: options.coverageDirectory,
	});

	const terminalColumns = getTerminalColumns();
	const hasTextReporter = options.reporters.some((name) => TEXT_REPORTERS.has(name));
	const allFilesFull = agentMode && isAllFilesFull(coverageMap);

	// Fully-covered runs collapse the text table to a single line; print it once
	// rather than per text reporter so configuring both text reporters can't
	// duplicate it.
	if (allFilesFull && hasTextReporter) {
		printCompactFullSummary(coverageMap);
	}

	for (const reporterName of options.reporters) {
		if (!isValidReporter(reporterName)) {
			throw new Error(`Unknown coverage reporter: ${reporterName}`);
		}

		if (allFilesFull && TEXT_REPORTERS.has(reporterName)) {
			continue;
		}

		let reporterOptions = {};
		if (reporterName === "text") {
			reporterOptions = { maxCols: terminalColumns, skipFull: agentMode };
		} else if (TEXT_REPORTERS.has(reporterName)) {
			reporterOptions = { skipFull: agentMode };
		}

		const report = istanbulReports.create(reporterName, reporterOptions);
		report.execute(context);
	}

	// skipFull leaves the table showing only sub-100% files; give the agent the
	// overall totals with raw counts so it knows exactly how much remains. An
	// empty map has nothing to total (Istanbul reports its pct as "Unknown"), so
	// skip it.
	if (agentMode && !allFilesFull && hasTextReporter && coverageMap.files().length > 0) {
		process.stdout.write(formatAgentTotals(coverageMap));
	}
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

	const failures: ThresholdResult["failures"] = [];

	const checks: Array<{ metric: string; threshold: number | undefined }> = [
		{ metric: "statements", threshold: thresholds.statements },
		{ metric: "functions", threshold: thresholds.functions },
		{ metric: "branches", threshold: thresholds.branches },
		{ metric: "lines", threshold: thresholds.lines },
	];

	const summarySchema = type({
		"[string]": { pct: "number | string" },
	});

	const summaryData = summarySchema(summary.toJSON());
	assert(!(summaryData instanceof type.errors), "Istanbul summary produced invalid data");

	for (const { metric, threshold } of checks) {
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

	return {
		failures,
		passed: failures.length === 0,
	};
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

	const columnsEnvironment = process.env["COLUMNS"];
	if (columnsEnvironment === undefined) {
		return undefined;
	}

	const parsed = Number(columnsEnvironment);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isAllFilesFull(coverageMap: CoverageMap): boolean {
	const files = coverageMap.files();
	if (files.length === 0) {
		return false;
	}

	return files.every((file) => {
		const summary = coverageMap.fileCoverageFor(file).toSummary();
		return (
			summary.statements.pct === 100 &&
			summary.branches.pct === 100 &&
			summary.functions.pct === 100 &&
			summary.lines.pct === 100
		);
	});
}

function buildCoverageMap(mapped: MappedCoverageResult): CoverageMap {
	const coverageMap = istanbulCoverage.createCoverageMap({});

	for (const [filePath, fileCoverage] of Object.entries(mapped.files)) {
		const fileCoverageData = {
			b: fileCoverage.b,
			branchMap: Object.fromEntries(
				Object.entries(fileCoverage.branchMap).map(([id, entry]) => {
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
			),
			f: fileCoverage.f,
			fnMap: Object.fromEntries(
				Object.entries(fileCoverage.fnMap).map(([id, entry]) => {
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
			),
			path: path.resolve(filePath),
			s: fileCoverage.s,
			statementMap: fileCoverage.statementMap,
		} satisfies FileCoverageData;
		coverageMap.addFileCoverage(fileCoverageData);
	}

	return coverageMap;
}

function isValidReporter(name: string): name is keyof ReportOptions {
	return VALID_REPORTERS.has(name);
}
