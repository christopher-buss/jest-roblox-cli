import assert from "node:assert";
import * as path from "node:path";
import process from "node:process";

import type { CoverageManifest } from "../coverage-data/manifest.ts";
import type { ExecuteResult } from "../executor/executor-types.ts";
import type { CoverageUnitSettings } from "../results/coverage-unit.ts";
import type {
	prepareWorkspaceCoverage,
	WorkspacePackageCoverage,
} from "../shadow/workspace-prepare.ts";
import type { TimedPhase, TimingCollector } from "../timing/orchestration-collector.ts";
import { PREPARE_COVERAGE_SPAN } from "../timing/span-names.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildWorkspaceCoveragePlan } from "./coverage-plan.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

/** Signature of the coverage prepare pass, injectable for tests. */
export type PrepareCoverage = typeof prepareWorkspaceCoverage;

/** One project's result, with its coverage manifest when instrumented. */
export interface WorkspaceProjectResult {
	/** The package's coverage manifest, when instrumented. */
	coverageManifest?: CoverageManifest | undefined;
	/** Present whenever `coverageManifest` is. */
	coverageSettings?: CoverageUnitSettings | undefined;
	/** Color of the project label; absent for the default. */
	displayColor?: string | undefined;
	/** Project display name. */
	displayName: string;
	/** Package name. */
	pkg: string;
	/** Execution result of the project. */
	result: ExecuteResult;
	/** Package root directory. */
	rootDir?: string | undefined;
}

/**
 * Instrument the packages that will run and opted into coverage.
 * @param options - Contexts, loaded packages, pending entries and seams.
 * @param options.contexts - Package contexts whose configs opt in.
 * @param options.fileSystem - File system to read and write through.
 * @param options.loaded - Loaded packages that supply the descriptors.
 * @param options.pending - Entries whose packages will run.
 * @param options.prepareCoverage - Coverage prepare pass.
 * @param options.timing - Collector for the `prepareCoverage` span.
 * @param options.cacheDirectory - Directory the package shadows are written under.
 * @returns Coverage per package name, and the time the pass took.
 */
export function prepareWorkspaceCoverageMap({
	cacheDirectory,
	contexts,
	fileSystem,
	loaded,
	pending,
	prepareCoverage,
	timing,
}: {
	cacheDirectory: string;
	contexts: Array<PackageContext>;
	fileSystem: FileSystem;
	loaded: Array<LoadedPackage>;
	pending: Array<PendingEntry>;
	prepareCoverage: PrepareCoverage;
	timing: TimingCollector;
}): TimedPhase<Map<string, WorkspacePackageCoverage>> {
	warnUnenforceableThresholds(contexts);
	const { packages } = buildWorkspaceCoveragePlan({ contexts, loaded, pending });
	if (packages.length === 0) {
		return { elapsedMs: 0, value: new Map<string, WorkspacePackageCoverage>() };
	}

	return timing.profileTimed(PREPARE_COVERAGE_SPAN, () => {
		return buildCoverageMap(prepareCoverage({ cacheDirectory, fileSystem, packages, timing }));
	});
}

/**
 * Pair each result with its pending entry and its package's coverage.
 * @param options - Coverage map, pending entries and results.
 * @param options.coverageByPackage - Coverage per instrumented package.
 * @param options.pending - Entries in dispatch order; `jobIndex` indexes them.
 * @param options.results - Execution results of the jobs that ran.
 * @returns One project result per execution result, in order.
 */
export function attachCoverageManifests({
	coverageByPackage,
	pending,
	results,
}: {
	readonly coverageByPackage: Map<string, WorkspacePackageCoverage>;
	readonly pending: Array<PendingEntry>;
	readonly results: Array<ExecuteResult & { jobIndex: number }>;
}): Array<WorkspaceProjectResult> {
	return results.map(({ jobIndex, ...result }) => {
		const pendingEntry = pending[jobIndex];
		assert(pendingEntry !== undefined, "every result names a pending entry");
		const { job, project } = pendingEntry;
		const coverage = coverageByPackage.get(job.pkg);
		const projectResult = {
			coverageManifest: coverage?.manifest,
			displayColor: project.displayColor,
			displayName: project.displayName,
			pkg: job.pkg,
			result,
			rootDir: job.config.rootDir,
		};
		return coverage === undefined
			? projectResult
			: {
					...projectResult,
					coverageSettings: readCoverageSettings(pendingEntry, coverage),
				};
	});
}

function warnUnenforceableThresholds(contexts: Array<PackageContext>): void {
	for (const ctx of contexts) {
		if (ctx.pkgConfig.coverageThreshold !== undefined && !ctx.pkgConfig.collectCoverage) {
			process.stderr.write(
				`jest-roblox: ${ctx.info.name} declares coverageThreshold but not collectCoverage; the threshold is not enforced\n`,
			);
		}
	}
}

function buildCoverageMap(
	entries: Array<WorkspacePackageCoverage>,
): Map<string, WorkspacePackageCoverage> {
	const map = new Map<string, WorkspacePackageCoverage>();
	for (const entry of entries) {
		map.set(entry.pkg, entry);
	}

	return map;
}

function readCoverageSettings(
	{ job: { config } }: PendingEntry,
	coverage: WorkspacePackageCoverage,
): CoverageUnitSettings {
	return {
		collectCoverageFrom: config.collectCoverageFrom,
		coverageDirectory: path.resolve(config.rootDir, config.coverageDirectory),
		coveragePathIgnorePatterns: coverage.coveragePathIgnorePatterns,
		coverageReporters: config.coverageReporters,
		coverageThreshold: config.coverageThreshold,
		rootDir: coverage.rootDir,
	};
}
