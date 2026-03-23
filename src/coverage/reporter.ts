import { type } from "arktype";
import istanbulCoverage from "istanbul-lib-coverage";
import istanbulReport from "istanbul-lib-report";
import istanbulReports, { type ReportOptions } from "istanbul-reports";
import assert from "node:assert";
import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { CoverageReporter } from "../config/schema.ts";
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
	coverageDirectory: string;
	mapped: MappedCoverageResult;
	reporters: Array<CoverageReporter>;
}

export interface ThresholdResult {
	failures: Array<{ actual: number; metric: string; threshold: number }>;
	passed: boolean;
}

type FileCoverageData = istanbulCoverage.FileCoverageData;

export function printCoverageHeader(): void {
	const header = ` ${color.blue("%")} ${color.dim("Coverage report from")} ${color.yellow("istanbul")}`;
	process.stdout.write(`\n${header}\n`);
}

export function generateReports(options: CoverageReportOptions): void {
	const coverageMap = buildCoverageMap(options.mapped);

	const context = istanbulReport.createContext({
		coverageMap,
		dir: options.coverageDirectory,
	});

	for (const reporterName of options.reporters) {
		if (!isValidReporter(reporterName)) {
			throw new Error(`Unknown coverage reporter: ${reporterName}`);
		}

		const report = istanbulReports.create(reporterName);
		report.execute(context);
	}
}

export function checkThresholds(
	mapped: MappedCoverageResult,
	thresholds: { branches?: number; functions?: number; lines?: number; statements?: number },
): ThresholdResult {
	const coverageMap = buildCoverageMap(mapped);
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

function buildCoverageMap(
	mapped: MappedCoverageResult,
): ReturnType<typeof istanbulCoverage.createCoverageMap> {
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
