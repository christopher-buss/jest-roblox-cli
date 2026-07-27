import * as path from "node:path";
import process from "node:process";
import color from "tinyrainbow";

import type { ResolvedConfig } from "../config/schema.ts";
import type { CoverageDisplayPredicate } from "../coverage-pipeline/agent-table-filter.ts";
import { mapCoverageToTypeScript, type MappedCoverageResult } from "../coverage-pipeline/mapper.ts";
import {
	checkThresholds,
	generateReports,
	printCoverageHeader,
	type ThresholdResult,
} from "../coverage-pipeline/reporter.ts";
import type { RawCoverageData } from "../coverage-pipeline/types.ts";
import { loadCoverageManifest } from "../executor.ts";
import { usesAgentFormatter } from "../formatters/utils.ts";
import type {
	MultiRunResult,
	WorkspacePackageCoverageGate,
	WorkspaceRunResult,
} from "../run/types.ts";

interface ProcessCoverageOptions {
	agentTextFilter?: CoverageDisplayPredicate | undefined;
	config: ResolvedConfig;
	coverageData: RawCoverageData | undefined;
	packageGates?: Array<WorkspacePackageCoverageGate> | undefined;
	preMapped?: MappedCoverageResult | undefined;
}

export function processCoverage({
	agentTextFilter,
	config,
	coverageData,
	packageGates,
	preMapped,
}: ProcessCoverageOptions): boolean {
	// preMapped is workspace pre-aggregated coverage from per-package opt-ins.
	// When present, generate reports regardless of workspace `collectCoverage`.
	if (preMapped === undefined && !config.collectCoverage) {
		return true;
	}

	const mapped = resolveMappedCoverage(config, coverageData, preMapped);
	if (mapped === undefined) {
		return true;
	}

	const isAgentMode = usesAgentFormatter(config.formatters, config.verbose);
	if (!config.silent) {
		printCoverageHeader(isAgentMode);
	}

	generateReports({
		agentMode: isAgentMode,
		agentTextFilter,
		collectCoverageFrom: config.collectCoverageFrom,
		coverageDirectory: path.resolve(config.rootDir, config.coverageDirectory),
		coveragePathIgnorePatterns: config.coveragePathIgnorePatterns,
		mapped,
		reporters: config.coverageReporters,
	});

	if (packageGates !== undefined) {
		return enforcePackageThresholds(config, packageGates);
	}

	return enforceThresholds(config, mapped);
}

export function printFinalStatus(passed: boolean): void {
	const badge = passed
		? color.bgGreen(color.black(color.bold(" PASS ")))
		: color.bgRed(color.white(color.bold(" FAIL ")));
	process.stdout.write(`${badge}\n`);
}

export function extractWorkspaceCoverageMapped(
	result: MultiRunResult | WorkspaceRunResult,
): MappedCoverageResult | undefined {
	return "coverageMapped" in result ? result.coverageMapped : undefined;
}

// Present only on workspace results that ran coverage; multi mode stays on the
// pooled `enforceThresholds` path.
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

function resolveMappedCoverage(
	config: ResolvedConfig,
	coverageData: RawCoverageData | undefined,
	preMapped: MappedCoverageResult | undefined,
): MappedCoverageResult | undefined {
	if (preMapped !== undefined) {
		// Workspace mode pre-aggregates per-package coverage using each
		// package's own manifest before reaching the formatter; skip the
		// single-package manifest lookup entirely.
		return preMapped;
	}

	if (coverageData === undefined) {
		if (!config.silent) {
			process.stderr.write(
				"Warning: coverage data was empty — the Rojo project may point at uninstrumented source\n",
			);
		}

		return undefined;
	}

	const manifest = loadCoverageManifest(config.rootDir);
	if (manifest === undefined) {
		if (!config.silent) {
			process.stderr.write("Warning: Coverage manifest not found, skipping TS mapping\n");
		}

		return undefined;
	}

	return mapCoverageToTypeScript(coverageData, manifest);
}

// Single owner of the threshold-failure wire format: the pooled path passes no
// prefix, the per-package path prefixes the package name.
function writeThresholdFailures(failures: ThresholdResult["failures"], prefix = ""): void {
	for (const failure of failures) {
		process.stderr.write(
			`Coverage threshold not met for ${prefix}${failure.metric}: ${failure.actual.toFixed(2)}% < ${String(failure.threshold)}%\n`,
		);
	}
}

// Workspace thresholds are per-package: each package is judged against its own
// universe, with the workspace-root threshold as the metric-level base and the
// package's declared threshold overriding the metrics it names (even
// downward — an explicit per-package value always wins). The pooled
// merged-universe check does not run in workspace mode; a cross-package
// average could mask a failing package.
function enforcePackageThresholds(
	config: ResolvedConfig,
	packages: Array<WorkspacePackageCoverageGate>,
): boolean {
	let isPassed = true;

	for (const gate of packages) {
		const effective = { ...config.coverageThreshold, ...gate.coverageThreshold };
		if (Object.keys(effective).length === 0) {
			continue;
		}

		// Unlike the pooled path, no `collectCoverageFrom` /
		// `coveragePathIgnorePatterns` narrowing here: each gate's universe was
		// already filtered per-package (its own ignore patterns) in
		// `aggregateWorkspaceCoverage`, and re-applying the workspace-root
		// values would override a package's own opt-out.
		const result = checkThresholds(gate.universe, effective);
		if (result.passed) {
			continue;
		}

		isPassed = false;
		writeThresholdFailures(result.failures, `${gate.pkg} `);
	}

	return isPassed;
}

function enforceThresholds(config: ResolvedConfig, mapped: MappedCoverageResult): boolean {
	if (config.coverageThreshold === undefined) {
		return true;
	}

	const result = checkThresholds(
		mapped,
		config.coverageThreshold,
		config.collectCoverageFrom,
		config.coveragePathIgnorePatterns,
	);
	if (result.passed) {
		return true;
	}

	writeThresholdFailures(result.failures);
	return false;
}
