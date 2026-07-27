import process from "node:process";

import type { ResolvedConfig } from "../config/schema.ts";
import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import {
	prepareWorkspaceCoverage,
	type WorkspacePackageCoverage,
} from "../coverage-pipeline/workspace-prepare.ts";
import type { ExecuteResult } from "../executor.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageContext } from "./project-contexts.ts";
import type { PendingEntry } from "./test-selection.ts";

export interface WorkspaceProjectResult {
	/**
	 * When coverage is enabled in workspace mode, the per-package manifest
	 * captured during `prepareWorkspaceCoverage`. Downstream aggregation maps
	 * the result's `coverageData` (raw hit counts captured by the materializer)
	 * back through this manifest to produce TS-coord Istanbul records.
	 */
	coverageManifest?: CoverageManifest | undefined;
	/**
	 * This package's effective `coveragePathIgnorePatterns`, carried so
	 * report- time aggregation applies the same per-package patterns
	 * instrumentation used. Present whenever `coverageManifest` is.
	 */
	coveragePathIgnorePatterns?: Array<string> | undefined;
	/**
	 * The package's own declared `coverageThreshold` (undefined when the
	 * package config never set one). Carried only alongside `coverageManifest`
	 * so the report layer can gate each package against its own coverage.
	 */
	coverageThreshold?: ResolvedConfig["coverageThreshold"] | undefined;
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
	loaded,
	pending,
	timing,
	workspaceRoot,
}: {
	contexts: Array<PackageContext>;
	loaded: Array<LoadedPackage>;
	pending: Array<PendingEntry>;
	timing: TimingCollector;
	workspaceRoot: string;
}): Map<string, WorkspacePackageCoverage> {
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
	if (packages.length === 0) {
		return new Map<string, WorkspacePackageCoverage>();
	}

	return timing.profile("prepareCoverage", () => {
		return buildCoverageMap(prepareWorkspaceCoverage({ packages, timing, workspaceRoot }));
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
		return {
			coverageManifest: coverage?.manifest,
			coveragePathIgnorePatterns: coverage?.coveragePathIgnorePatterns,
			...(coverage !== undefined
				? { coverageThreshold: pendingEntry.projectConfig.coverageThreshold }
				: {}),
			displayName: pendingEntry.project.displayName,
			pkg: pendingEntry.pkg,
			result,
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
