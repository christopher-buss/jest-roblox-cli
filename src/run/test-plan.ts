import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { hasUserAuthoredConfig } from "../config/stubs.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry } from "../typecheck/group-by-tsconfig.ts";
import { classifyTestFiles, discoverTestFiles } from "./discovery.ts";

export interface PendingJob {
	config: ResolvedConfig;
	displayColor?: string | undefined;
	displayName: string;
	runtimeFiles: Array<string>;
	// Mount paths the Studio runner should inject `jest.config` into; empty
	// when every mount already has a user-authored config on disk.
	runtimeInjectionPaths: Array<string>;
}

/**
 * What an empty run reports. Empty under `passWithNoTests` is a pass, so both
 * fields are absent; otherwise they carry the exit code and the stderr notice.
 * The field names match `MultiRunResult`'s so a caller spreads this straight
 * into its result.
 */
export interface EmptyRunPolicy {
	validationExitCode?: 2 | undefined;
	validationMessage?: string | undefined;
}

export interface TestPlan {
	/**
	 * Present exactly when the plan selected nothing to do. The run must stop
	 * here — before a backend is resolved or a place is built.
	 */
	emptiness?: EmptyRunPolicy | undefined;
	jobs: Array<PendingJob>;
	/**
	 * Every runtime file across every job — the coverage display-filter input.
	 */
	matchedRuntimeFiles: Array<string>;
	typeTestEntries: Array<TypecheckGroupEntry>;
}

/**
 * The project set and filters every discovery pass in one run shares.
 * `buildTestPlan` adds the place the jobs will execute against.
 */
export interface RunDiscovery extends DiscoveryFilters {
	timing: TimingCollector;
}

export interface TestPlanInput extends RunDiscovery {
	/**
	 * The place the runtime jobs execute against — the coverage-instrumented
	 * place when `--coverage` rebuilt one, the root config's place otherwise. A
	 * type-only plan never runs a job, so it may pass the root config's value.
	 */
	effectivePlaceFile: string;
}

/** Everything discovery needs except the profiler and the target place. */
interface DiscoveryFilters {
	cliFiles: Array<string> | undefined;
	cliTypecheck: TypecheckCliOptions;
	/**
	 * Per-project subset of `cliFiles` when auto-pick filtered cli files to
	 * specific projects. When absent or missing for a given project, the full
	 * `cliFiles` array is used (back-compat for `--project` and no-positional
	 * flows).
	 */
	filesByProject?: ReadonlyMap<string, Array<string>> | undefined;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

interface DiscoveryInput extends DiscoveryFilters {
	effectivePlaceFile: string;
}

interface PlannedProject {
	job?: PendingJob | undefined;
	typeTestEntry?: TypecheckGroupEntry | undefined;
}

interface ProjectSelection {
	config: ResolvedConfig;
	runtimeFiles: Array<string>;
	typeTestFiles: Array<string>;
}

/**
 * Turn a selected project set into the exact work a run will do: one
 * `PendingJob` per project with runtime files, one `TypecheckGroupEntry` per
 * project with Type Tests, and the empty-run policy when neither produced
 * anything.
 *
 * The seam is **plural, not per-project**: `createSetupResolver` eagerly walks
 * the whole rojo tree, so one pass over every project shares that work (see
 * `resolveAllSetupFilePaths`). Setup paths must already be resolved when this
 * runs — the plan reads them off each project's config as-is.
 */
export function buildTestPlan({ timing, ...discovery }: TestPlanInput): TestPlan {
	const { jobs, typeTestEntries } = timing.profile("collectPendingJobs", () => {
		return collectPendingJobs(discovery);
	});

	const plan: TestPlan = {
		jobs,
		matchedRuntimeFiles: jobs.flatMap((job) => job.runtimeFiles),
		typeTestEntries,
	};
	if (jobs.length > 0 || typeTestEntries.length > 0) {
		return plan;
	}

	return {
		...plan,
		emptiness: discovery.rootConfig.passWithNoTests
			? {}
			: { validationExitCode: 2, validationMessage: "No test files found in any project\n" },
	};
}

// Type Tests are discovered by `-d` globs derived from the Runtime `include`
// (or an explicit `test.typecheck.include`). These stay in the local discovery
// `testMatch` only — never folded into `project.include` — so coverage-source
// derivation (which reads `project.include`) never sees a `-d` glob.
function buildDiscoveryConfig(
	project: ResolvedProjectConfig,
	effectivePlaceFile: string,
	typecheck: ResolvedTypecheckConfig,
): ResolvedConfig {
	const typecheckInclude = typecheck.enabled
		? (typecheck.include ?? deriveTypecheckInclude(project.include))
		: [];
	return {
		...project.config,
		placeFile: effectivePlaceFile,
		projects: project.projects,
		testMatch: [...project.include, ...typecheckInclude],
	};
}

function selectProjectFiles(
	project: ResolvedProjectConfig,
	effectivePlaceFile: string,
	projectCliFiles: Array<string> | undefined,
	typecheck: ResolvedTypecheckConfig,
): ProjectSelection {
	const discoveryConfig = buildDiscoveryConfig(project, effectivePlaceFile, typecheck);
	const discovered = discoverTestFiles(discoveryConfig, projectCliFiles);
	const classified = classifyTestFiles(discovered.files, typecheck);

	// `exclude` globs only match the relative paths glob-discovery returns;
	// explicit positional files come back absolute and are user-chosen, so they
	// bypass `exclude` — mirroring how `testPathIgnorePatterns` is already
	// skipped for positionals in `discoverTestFiles`. Runtime files use the
	// project's `exclude`; type tests use `test.typecheck.exclude`.
	const isPositional = (projectCliFiles?.length ?? 0) > 0;
	const runtimeFiles = isPositional
		? classified.runtimeFiles
		: applyExcludes(classified.runtimeFiles, project.exclude);

	// Narrow by the per-project discovered files (not the raw positional/flag
	// input) so the Luau runner receives an Instance-namespace basename pattern.
	// A bare project run (no positionals, no `--testPathPattern`) keeps
	// `testPathPattern` undefined so Jest-on-Roblox runs all testMatch.
	const isFilterActive = isPositional || discoveryConfig.testPathPattern !== undefined;
	const narrowed = { ...discoveryConfig, testMatch: project.testMatch };
	return {
		config: narrowForLuauRun(narrowed, runtimeFiles, isFilterActive),
		runtimeFiles,
		typeTestFiles: isPositional
			? classified.typeTestFiles
			: applyExcludes(classified.typeTestFiles, typecheck.exclude),
	};
}

// Same per-mount FS filter as the synthesizer's stubMounts loop: drop mounts
// where a user-authored `jest.config.luau` already exists. The runtime injector
// mustn't parent a duplicate `jest.config` over a Rojo-synced user file.
function collectRuntimeInjectionPaths(
	project: ResolvedProjectConfig,
	rootDirectory: string,
): Array<string> {
	const runtimeInjectionPaths: Array<string> = [];
	for (const mount of project.rojoMounts) {
		const sourceMount = path.resolve(rootDirectory, mount.fsPath);
		if (hasUserAuthoredConfig(sourceMount)) {
			continue;
		}

		runtimeInjectionPaths.push(mount.dataModelPath);
	}

	return runtimeInjectionPaths;
}

function planProject(
	project: ResolvedProjectConfig,
	{ cliFiles, cliTypecheck, effectivePlaceFile, filesByProject, rootConfig }: DiscoveryInput,
): PlannedProject {
	// When auto-pick produced a per-project file subset, only feed those files
	// into discovery / narrowing for this project. Otherwise (no positional
	// files, or explicit `--project`), fall back to the full cli.files list.
	const projectCliFiles = filesByProject?.get(project.displayName) ?? cliFiles;
	const typecheck = resolveTypecheckConfig({
		cli: cliTypecheck,
		project: project.typecheck,
		root: rootConfig.typecheck,
	});
	const selection = selectProjectFiles(project, effectivePlaceFile, projectCliFiles, typecheck);

	const planned: PlannedProject = {};
	// Each project carries its own effective `(tsconfig, cwd)` into the type
	// pass; `groupTypecheckByTsconfig` collapses projects sharing one and checks
	// distinct tsconfigs separately. cwd is always the workspace root in
	// projects mode (all projects build from one tree).
	if (selection.typeTestFiles.length > 0) {
		planned.typeTestEntry = {
			cwd: rootConfig.rootDir,
			files: selection.typeTestFiles,
			...(typecheck.tsconfig !== undefined ? { tsconfig: typecheck.tsconfig } : {}),
		};
	}

	if (selection.runtimeFiles.length > 0) {
		planned.job = {
			config: selection.config,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeFiles: selection.runtimeFiles,
			runtimeInjectionPaths: collectRuntimeInjectionPaths(project, rootConfig.rootDir),
		};
	}

	return planned;
}

function collectPendingJobs(input: DiscoveryInput): {
	jobs: Array<PendingJob>;
	typeTestEntries: Array<TypecheckGroupEntry>;
} {
	const jobs: Array<PendingJob> = [];
	const typeTestEntries: Array<TypecheckGroupEntry> = [];

	for (const project of input.projects) {
		const planned = planProject(project, input);
		if (planned.typeTestEntry !== undefined) {
			typeTestEntries.push(planned.typeTestEntry);
		}

		if (planned.job !== undefined) {
			jobs.push(planned.job);
		}
	}

	return { jobs, typeTestEntries };
}
