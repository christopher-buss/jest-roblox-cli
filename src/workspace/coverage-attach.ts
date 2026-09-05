import * as path from "node:path";
import process from "node:process";

import type { CoverageReporter, ResolvedConfig } from "../config/schema.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import {
	prepareWorkspaceCoverage,
	type WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import type { TimedPhase, TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

/**
 * Everything a package's coverage report and gate are built from, read off that
 * package's own resolved config. A workspace run has no config of its own — the
 * file at the invocation directory is bootstrap only — so these values are the
 * whole story for the package: the universe it reports, where the report lands,
 * which reporters render it, and the threshold it is judged against.
 */
export interface PackageCoverageSettings {
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
	coverageReporters: Array<CoverageReporter>;
	coverageThreshold?: ResolvedConfig["coverageThreshold"] | undefined;
	/**
	 * The package's own `rootDir`: what `collectCoverageFrom` is written
	 * relative to. Carried because the invocation directory is the workspace
	 * root, which belongs to no package — anchoring there would make
	 * `src/**` name the workspace's sources rather than the package's.
	 */
	rootDir: string;
}

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
	displayName: string;
	pkg: string;
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
 */
export function prepareWorkspaceCoverageMap({
	contexts,
	fileSystem = nodeFileSystem,
	loaded,
	pending,
	timing,
	workspaceRoot,
}: {
	contexts: Array<PackageContext>;
	/** Where instrumentation reads and writes. Defaults to the real one. */
	fileSystem?: FileSystem;
	loaded: Array<LoadedPackage>;
	pending: Array<PendingEntry>;
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
		return buildCoverageMap(
			prepareWorkspaceCoverage({ fileSystem, packages, timing, workspaceRoot }),
		);
	});
}

export function attachCoverageManifests(
	results: Array<ExecuteResult>,
	pending: Array<PendingEntry>,
	coverageByPackage: Map<string, WorkspacePackageCoverage>,
): Array<WorkspaceProjectResult> {
	return results.map((result, index) => {
		// eslint-disable-next-line ts/no-non-null-assertion -- runProjects preserves order
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

// A threshold without collectCoverage can never be enforced — the package is
// never instrumented, so its gate silently vanishes. Surface the
// misconfiguration instead of letting it pass unnoticed.
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

// The ignore patterns and the glob anchor come from the prepare pass rather
// than the config so the report filters on exactly what instrumentation
// filtered on; everything else is report-time only and reads straight off the
// package's resolved config.
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
