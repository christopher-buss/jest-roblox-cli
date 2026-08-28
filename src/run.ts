import { mergeCliWithConfig } from "./config/merge.ts";
import { resolveTypecheckConfig } from "./config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "./config/schema.ts";
import { emitBuildManifest } from "./coverage-pipeline/build-manifest.ts";
import { COVERAGE_BUILD_MANIFEST_PATH } from "./coverage-pipeline/prepare.ts";
import { NOOP_RUN_PROGRESS, type RunProgress } from "./progress/reporter.ts";
import { loadRojoTree, runMultiProjectAsync, runResolvedProjectsAsync } from "./run/multi.ts";
import { buildImplicitProject } from "./run/single-projects.ts";
import type { MultiRunResult, WorkspaceRunResult } from "./run/types.ts";
import { isWorkspaceInvocation } from "./run/workspace-validation.ts";
import { runWorkspaceModeAsync } from "./run/workspace.ts";
import { createTimingCollector, type TimingCollector } from "./timing/orchestration-collector.ts";

/**
 * Single/multi dispatch shared by `runJestRoblox` and `prepareArtifacts`. Both
 * are siblings over this core: it builds the Coverage-Instrumented Place and
 * runs the suite, returning `coverageArtifacts` for the caller to emit a Build
 * Manifest from — the core never writes that manifest itself.
 */
export async function runSingleOrMultiAsync(
	cli: CliOptions,
	merged: ResolvedConfig,
	timing: TimingCollector,
): Promise<MultiRunResult> {
	const rawProjects = merged.projects;
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return runMultiProjectAsync({ cli, config: merged, rawProjects, timing });
	}

	// No explicit `projects`: synthesize one project from the config's luau
	// roots so the runner gets the per-root `jest.config` stub and rebuilt place
	// it requires (the runner resolves per-project config from a `jest.config`
	// ModuleScript at each project root), then run it through the multi
	// pipeline.
	//
	// A pure typecheck-only run is host-local tsgo: `runResolvedProjects`
	// short-circuits into `runMultiTypecheckOnly` before any backend, place, or
	// coverage work, and nothing is mounted into a DataModel. It therefore needs
	// no Rojo project **on disk** — so the tree is left unloaded and the
	// implicit project carries no mounts.
	const typecheck = resolveTypecheckConfig({
		cli: { enabled: cli.typecheck, only: cli.typecheckOnly, tsconfig: cli.typecheckTsconfig },
		root: merged.typecheck,
	});
	const rojoTree = typecheck.only
		? undefined
		: timing.profile("loadRojoTree", () => loadRojoTree(merged));
	const project = buildImplicitProject(merged, rojoTree);
	return runResolvedProjectsAsync([project], merged, cli, timing);
}

export async function runJestRobloxAsync(
	cli: CliOptions,
	config: ResolvedConfig,
	progress: RunProgress = NOOP_RUN_PROGRESS,
): Promise<MultiRunResult | WorkspaceRunResult> {
	// One collector per top-level run, flushed in `finally` so a TIMING run
	// still emits the host waterfall when a profiled phase throws (missing
	// lute, rojo build failure, dispatch timeout) — exactly the slow or
	// broken runs the profiler exists to diagnose. The stage reporter rides
	// with it: the phases it profiles are the stages it announces.
	//
	// The reporter is passed in rather than built here, because the run is not
	// the whole invocation: the coverage merge and its report come after this
	// returns, and whoever owns the terminal owns settling the block.
	const timing = createTimingCollector({ progress });
	try {
		// Workspace mode resolves its own per-package config. The one exception
		// is `workspace.root`/`workspace.packages`: those come from the
		// bootstrap config (loaded from cwd or --workspace-root, root anchored
		// absolute at load) and drive package enumeration in repos without a
		// pnpm-workspace.yaml.
		if (isWorkspaceInvocation(cli)) {
			return await runWorkspaceModeAsync(cli, config.workspace, timing);
		}

		// Single/multi paths keep the CLI > config precedence so programmatic
		// callers passing a raw config still get CLI overrides folded in.
		const merged = mergeCliWithConfig(cli, config);
		const result = await runSingleOrMultiAsync(cli, merged, timing);

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
