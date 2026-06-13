import { mergeCliWithConfig } from "./config/merge.ts";
import type { CliOptions, ProjectEntry, ResolvedConfig } from "./config/schema.ts";
import { emitBuildManifest } from "./coverage-pipeline/build-manifest.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "./coverage-pipeline/prepare.ts";
import { runMultiProject } from "./run/multi.ts";
import { runSingleProject } from "./run/single.ts";
import type { MultiRunResult, RunResult, SingleRunResult } from "./run/types.ts";
import { runWorkspaceMode } from "./run/workspace.ts";
import { createTimingCollector, type TimingCollector } from "./timing/orchestration-collector.ts";

export function isWorkspaceInvocation(cli: CliOptions): boolean {
	return cli.workspace === true || cli.packages !== undefined || cli.affectedSince !== undefined;
}

/**
 * The raw `projects` entries off a resolved config. `ResolvedConfig.projects` is
 * structurally typed `Array<string>` post-resolution, but single/multi dispatch
 * reads it before resolution when entries are still raw `ProjectEntry`. The cast
 * is bounded by the `Array.isArray`-style length check at every call site.
 */
export function getRawProjects(config: ResolvedConfig): Array<ProjectEntry> | undefined {
	return (config as unknown as { projects?: Array<ProjectEntry> }).projects;
}

/**
 * Single/multi dispatch shared by `runJestRoblox` and `prepareArtifacts`. Both
 * are siblings over this core: it builds the Coverage-Instrumented Place and
 * runs the suite, returning `coverageArtifacts` for the caller to emit a Build
 * Manifest from — the core never writes that manifest itself.
 */
export async function runSingleOrMulti(
	cli: CliOptions,
	merged: ResolvedConfig,
	timing: TimingCollector,
): Promise<MultiRunResult | SingleRunResult> {
	const rawProjects = getRawProjects(merged);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return runMultiProject({ cli, config: merged, rawProjects, timing });
	}

	return runSingleProject({ cli, config: merged, timing });
}

export async function runJestRoblox(cli: CliOptions, config: ResolvedConfig): Promise<RunResult> {
	// One collector per top-level run, flushed in `finally` so a TIMING run
	// still emits the host waterfall when a profiled phase throws (missing
	// lute, rojo build failure, dispatch timeout) — exactly the slow or
	// broken runs the profiler exists to diagnose. Disabled (TIMING unset)
	// every span is a no-op so behavior stays byte-identical.
	const timing = createTimingCollector();
	try {
		// Workspace mode resolves its own per-package config. The one exception
		// is `workspace.root`/`workspace.packages`: those come from the
		// bootstrap config (loaded from cwd or --workspace-root, root anchored
		// absolute at load) and drive package enumeration in repos without a
		// pnpm-workspace.yaml.
		if (isWorkspaceInvocation(cli)) {
			return await runWorkspaceMode(cli, config.workspace, timing);
		}

		// Single/multi paths keep the CLI > config precedence so programmatic
		// callers passing a raw config still get CLI overrides folded in.
		const merged = mergeCliWithConfig(cli, config);
		const result = await runSingleOrMulti(cli, merged, timing);

		// Entry point owns Build Manifest emission. A `runJestRoblox` run never
		// builds a Clean Place, so it records `coveragePlace` only. The reuse
		// path leaves the prior (still-valid) manifest untouched.
		if (result.coverageArtifacts?.rebuilt === true) {
			emitBuildManifest(COVERAGE_BUILD_MANIFEST_PATH, result.coverageArtifacts);
		}

		return result;
	} finally {
		timing.flushTimingReport();
	}
}
