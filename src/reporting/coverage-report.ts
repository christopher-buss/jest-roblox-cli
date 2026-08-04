import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { CoverageReporter, ResolvedConfig } from "../config/schema.ts";
import type { CoverageDisplayPredicate } from "../coverage-pipeline/agent-table-filter.ts";
import { mapCoverageToTypeScript, type MappedCoverageResult } from "../coverage-pipeline/mapper.ts";
import {
	checkThresholds,
	generateReports,
	printCoverageHeader,
} from "../coverage-pipeline/reporter.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { loadCoverageManifest } from "../executor.ts";
import { usesAgentFormatter } from "../formatters/utils.ts";
import type {
	MultiRunResult,
	WorkspacePackageCoverageGate,
	WorkspaceRunResult,
} from "../run/types.ts";

/**
 * One coverage report and the gate over the same universe. Single and multi
 * build exactly one from the resolved config; workspace builds one per package
 * from that package's own config. Both then run the identical emit-and-gate
 * loop, so a change to how a report renders or how a threshold is judged lands
 * in every mode at once.
 */
interface CoverageReportUnit {
	/**
	 * Still to be applied at report time. Undefined for a workspace package:
	 * its universe was narrowed in `aggregateWorkspaceCoverage`, where package
	 * identity was still known, and re-applying anything here would override a
	 * package's own opt-out.
	 */
	collectCoverageFrom?: Array<string> | undefined;
	/** Absolute output directory for the file reporters. */
	coverageDirectory: string;
	coveragePathIgnorePatterns?: Array<string> | undefined;
	coverageThreshold?: ResolvedConfig["coverageThreshold"];
	/** Prefixes threshold failures and heads the report; the package name. */
	label?: string | undefined;
	reporters: Array<CoverageReporter>;
	universe: MappedCoverageResult;
}

interface ProcessCoverageOptions {
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	config: ResolvedConfig;
	coverageData: RawCoverageData | undefined;
	packageGates?: Array<WorkspacePackageCoverageGate> | undefined;
}

export function processCoverage({
	agentTextFilter,
	config,
	coverageData,
	packageGates,
}: ProcessCoverageOptions): boolean {
	// Workspace coverage is opted into per package, so the gates decide whether
	// anything runs — there is no run-level `collectCoverage` to consult.
	const units =
		packageGates === undefined
			? resolveSingleUnit(config, coverageData)
			: packageGates.map(toPackageUnit);
	if (units.length === 0) {
		return true;
	}

	const isAgentMode = usesAgentFormatter(config.formatters, config.verbose);
	if (!config.silent) {
		printCoverageHeader(isAgentMode);
	}

	let isPassed = true;
	for (const unit of units) {
		if (unit.label !== undefined && !config.silent) {
			process.stdout.write(`\n${unit.label}\n`);
		}

		generateReports({
			agentMode: isAgentMode,
			agentTextFilter,
			collectCoverageFrom: unit.collectCoverageFrom,
			coverageDirectory: unit.coverageDirectory,
			coveragePathIgnorePatterns: unit.coveragePathIgnorePatterns,
			mapped: unit.universe,
			reporters: unit.reporters,
		});

		isPassed = enforceUnitThreshold(unit) && isPassed;
	}

	return isPassed;
}

export function printFinalStatus(passed: boolean): void {
	const badge = passed
		? color.bgGreen(color.black(color.bold(" PASS ")))
		: color.bgRed(color.white(color.bold(" FAIL ")));
	process.stdout.write(`${badge}\n`);
}

// Present only on workspace results that ran coverage; multi mode reports and
// gates one universe built from its own resolved config.
export function extractCoveragePackages(
	result: MultiRunResult | WorkspaceRunResult,
): Array<WorkspacePackageCoverageGate> | undefined {
	return result.mode === "workspace" ? result.coveragePackages : undefined;
}

// `coverageDisplayFilter` lives on `MultiRunResult` only; workspace runs never
// narrow the agent table (they consume no positional/file filter). The mode
// discriminant states that invariant directly — immune to the field ever being
// added to `WorkspaceRunResult`.
export function extractCoverageDisplayFilter(
	result: MultiRunResult | WorkspaceRunResult,
): CoverageDisplayPredicate | undefined {
	return result.mode === "multi" ? result.coverageDisplayFilter : undefined;
}

// A workspace package arrives report-ready: its universe was mapped through the
// package's own manifest and narrowed by the package's own globs, so the only
// thing left to say is where the report goes and what renders it.
function toPackageUnit(gate: WorkspacePackageCoverageGate): CoverageReportUnit {
	return {
		coverageDirectory: gate.coverageDirectory,
		coverageThreshold: gate.coverageThreshold,
		label: gate.pkg,
		reporters: gate.coverageReporters,
		universe: gate.universe,
	};
}

// Single and multi report one universe, mapped here from the run's raw hit
// counts through the one manifest at `rootDir`. Returns no unit — so no header,
// no report, no gate — when coverage is off or nothing mappable came back.
function resolveSingleUnit(
	config: ResolvedConfig,
	coverageData: RawCoverageData | undefined,
): Array<CoverageReportUnit> {
	if (!config.collectCoverage) {
		return [];
	}

	if (coverageData === undefined) {
		if (!config.silent) {
			process.stderr.write(
				"Warning: coverage data was empty — the Rojo project may point at uninstrumented source\n",
			);
		}

		return [];
	}

	const manifest = loadCoverageManifest(config.rootDir);
	if (manifest === undefined) {
		if (!config.silent) {
			process.stderr.write("Warning: Coverage manifest not found, skipping TS mapping\n");
		}

		return [];
	}

	return [
		{
			collectCoverageFrom: config.collectCoverageFrom,
			coverageDirectory: path.resolve(config.rootDir, config.coverageDirectory),
			coveragePathIgnorePatterns: config.coveragePathIgnorePatterns,
			coverageThreshold: config.coverageThreshold,
			reporters: config.coverageReporters,
			universe: mapCoverageToTypeScript(coverageData, manifest),
		},
	];
}

// Judge a unit against the threshold its own config declared. Nothing gates a
// unit that declares none: in workspace mode there is no run-level threshold to
// fall back to (the only candidate would be whatever config sits at the
// invocation directory, which would make the same package pass or fail
// depending on where the CLI was run), and no pooled cross-package check either
// — a cross-package average could mask a failing package.
function enforceUnitThreshold(unit: CoverageReportUnit): boolean {
	if (unit.coverageThreshold === undefined) {
		return true;
	}

	const result = checkThresholds(
		unit.universe,
		unit.coverageThreshold,
		unit.collectCoverageFrom,
		unit.coveragePathIgnorePatterns,
	);
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
