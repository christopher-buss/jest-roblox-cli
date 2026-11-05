import * as path from "node:path";
import process from "node:process";

import type { CoverageReporter, ResolvedConfig } from "../config/schema.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import type {
	prepareWorkspaceCoverage,
	WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import type { TimedPhase, TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PendingEntry } from "./pending-entry.ts";
import type { PackageContext } from "./project-contexts.ts";

/** Signature of the coverage prepare pass, injectable for tests. */
export type PrepareCoverage = typeof prepareWorkspaceCoverage;

/**
 * Everything a package's coverage report and gate are built from, read off that
 * package's own resolved config. A workspace run has no config of its own — the
 * file at the invocation directory is bootstrap only — so these values are the
 * whole story for the package: the universe it reports, where the report lands,
 * which reporters render it, and the threshold it is judged against.
 */
export interface PackageCoverageSettings {
	/** Package's `collectCoverageFrom` globs, if set. */
	collectCoverageFrom?: Array<string> | undefined;
	/**
	 * Absolute: the package's `coverageDirectory` against its own `rootDir`.
	 */
	coverageDirectory: string;
	/**
	 * The package's effective patterns, as instrumentation resolved them.
	 * Applied to the mapped universe before the report so a per-package opt-out
	 * scopes to that package's files.
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/** Reporters for the package's coverage report. */
	coverageReporters: Array<CoverageReporter>;
	/** Thresholds for the package's coverage gate, if set. */
	coverageThreshold?: ResolvedConfig["coverageThreshold"] | undefined;
	/**
	 * The package's own `rootDir`: what `collectCoverageFrom` is written
	 * relative to. Carried because the invocation directory is the workspace
	 * root, which belongs to no package — anchoring there would make
	 * `src/**` name the workspace's sources rather than the package's.
	 */
	rootDir: string;
}

/** One project's result, with its coverage manifest when instrumented. */
export interface WorkspaceProjectResult {
	/**
	 * When coverage is enabled in workspace mode, the per-package manifest
	 * captured during `prepareWorkspaceCoverage`. Downstream aggregation maps
	 * the result's `coverageData` (raw hit counts captured by the materializer)
	 * back through this manifest to produce TS-coord Istanbul records.
	 */
	coverageManifest?: CoverageManifest | undefined;
	/** Present whenever `coverageManifest` is. */
	coverageSettings?: PackageCoverageSettings | undefined;
	/** Project display name. */
	displayName: string;
	/** Package name. */
	pkg: string;
	/** Execution result of the project. */
	result: ExecuteResult;
}

/**
 * Instrument the packages that will actually run, keyed by package name.
 *
 * Limited to packages that have pending tests AND opted into coverage via their
 * own config. Per-package opt-in matches passWithNoTests: the workspace root's
 * value is not aggregated over packages. Instrumenting packages that won't run
 * (or didn't ask for coverage) wastes time on every run (instrumentation is the
 * dominant pre-OCALE cost).
 * @param options - Contexts, loaded packages, pending entries and seams.
 * @param options.contexts - Package contexts whose configs opt in.
 * @param options.fileSystem - File system to read and write through.
 * @param options.loaded - Loaded packages that supply the descriptors.
 * @param options.pending - Entries whose packages will run.
 * @param options.prepareCoverage - Coverage prepare pass.
 * @param options.timing - Collector for the `prepareCoverage` span.
 * @param options.workspaceRoot - Workspace root directory.
 * @returns Coverage per package name, and the time the pass took.
 */
export function prepareWorkspaceCoverageMap({
	contexts,
	fileSystem,
	loaded,
	pending,
	prepareCoverage,
	timing,
	workspaceRoot,
}: {
	contexts: Array<PackageContext>;
	fileSystem: FileSystem;
	loaded: Array<LoadedPackage>;
	pending: Array<PendingEntry>;
	prepareCoverage: PrepareCoverage;
	timing: TimingCollector;
	workspaceRoot: string;
}): TimedPhase<Map<string, WorkspacePackageCoverage>> {
	const pendingPackageNames = new Set(pending.map((entry) => entry.pkg));
	const coverageOptIn = new Set(
		contexts.filter((ctx) => ctx.pkgConfig.collectCoverage).map((ctx) => ctx.info.name),
	);
	warnUnenforceableThresholds(contexts);

	const packages = loaded
		.map((entry) => entry.descriptor)
		.filter((descriptor) => {
			return pendingPackageNames.has(descriptor.name) && coverageOptIn.has(descriptor.name);
		});
	// No span, and so no duration, when nothing opted in: opening
	// `prepareCoverage` would announce an instrument stage that never
	// instruments, and put a coverage segment on a run that collected none.
	// The filtering above is then unmeasured, like any other work no phase
	// names, and lands in the run's `cli` residual.
	if (packages.length === 0) {
		return { elapsedMs: 0, value: new Map<string, WorkspacePackageCoverage>() };
	}

	return timing.profileTimed("prepareCoverage", () => {
		return buildCoverageMap(prepareCoverage({ fileSystem, packages, timing, workspaceRoot }));
	});
}

/**
 * Pair each result with its package's coverage manifest and settings.
 * @param options - Coverage map, pending entries and results.
 * @param options.coverageByPackage - Coverage per instrumented package.
 * @param options.pending - Entries in the same order as `results`.
 * @param options.results - Execution results.
 * @returns One project result per execution result, in order.
 */
export function attachCoverageManifests({
	coverageByPackage,
	pending,
	results,
}: {
	readonly coverageByPackage: Map<string, WorkspacePackageCoverage>;
	readonly pending: Array<PendingEntry>;
	readonly results: Array<ExecuteResult>;
}): Array<WorkspaceProjectResult> {
	return results.map((result, index) => {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- runProjects preserves order
		const pendingEntry = pending[index]!;
		const coverage = coverageByPackage.get(pendingEntry.pkg);
		const projectResult = {
			coverageManifest: coverage?.manifest,
			displayName: pendingEntry.project.displayName,
			pkg: pendingEntry.pkg,
			result,
		};
		return coverage === undefined
			? projectResult
			: {
					...projectResult,
					coverageSettings: readCoverageSettings(pendingEntry, coverage),
				};
	});
}

/**
 * A threshold without collectCoverage can never be enforced — the package is
 * never instrumented, so its gate silently vanishes. Surface the
 * misconfiguration instead of letting it pass unnoticed.
 * @param contexts - Package contexts to check.
 */
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

/**
 * The ignore patterns and the glob anchor come from the prepare pass rather
 * than the config so the report filters on exactly what instrumentation
 * filtered on; everything else is report-time only and reads straight off the
 * package's resolved config.
 * @param entry - Pending entry whose project config to read.
 * @param coverage - Prepare-pass output for the package.
 * @returns The settings the package's report and gate use.
 */
function readCoverageSettings(
	{ projectConfig }: PendingEntry,
	coverage: WorkspacePackageCoverage,
): PackageCoverageSettings {
	return {
		collectCoverageFrom: projectConfig.collectCoverageFrom,
		coverageDirectory: path.resolve(projectConfig.rootDir, projectConfig.coverageDirectory),
		coveragePathIgnorePatterns: coverage.coveragePathIgnorePatterns,
		coverageReporters: projectConfig.coverageReporters,
		coverageThreshold: projectConfig.coverageThreshold,
		rootDir: coverage.rootDir,
	};
}
