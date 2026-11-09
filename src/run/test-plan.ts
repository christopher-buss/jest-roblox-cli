import * as path from "node:path";
import type { Except } from "type-fest";

import { createInstancePathResolver } from "../config/instance-path.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { mountsWithoutUserConfig } from "../config/stub-files.ts";
import { buildProjectJob } from "../executor.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	resolveAllTsconfigMappings,
} from "../executor/tsconfig-mappings.ts";
import type { AffectedSummary, PartialRunCause } from "../formatters/shared.ts";
import { luauParser } from "../luau/parser.ts";
import type { PartialRun } from "../related/partial-run.ts";
import type { RelatedFileFilter } from "../related/related-tests.ts";
import { createRelatedFileFilter } from "../related/related-tests.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import {
	assertTypecheckAvailable,
	type TypecheckGroupEntry,
} from "../typecheck/typecheck-groups.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ProjectSelection } from "./project-files.ts";
import { selectProjectFiles } from "./project-files.ts";
import type { RunSeams } from "./seams.ts";

/** One project's runtime test job. */
export interface PendingJob {
	/** Project config narrowed to the job's files. */
	config: ResolvedConfig;
	/** Color of the project label; absent for the default. */
	displayColor?: string | undefined;
	/** Label the project prints under. */
	displayName: string;
	/** Runtime test files of the job. */
	runtimeFiles: Array<string>;
	/**
	 * Mount paths the Studio runner should inject `jest.config` into; empty
	 * when every mount already has a user-authored config on disk.
	 */
	runtimeInjectionPaths: Array<string>;
}

/**
 * What an empty run reports. Empty under `passWithNoTests` is a pass, so it
 * has no exit code, and only a Partial Run has a notice; otherwise both
 * fields carry the exit code and the stderr notice.
 * The field names match `MultiRunResult`'s so a caller spreads this straight
 * into its result.
 */
export interface EmptyRunPolicy {
	/** Exit code `2` when an empty run fails. */
	validationExitCode?: 2 | undefined;
	/** Notice for stderr when the run is empty. */
	validationMessage?: string | undefined;
}

/** The work a run does, before any place is bound. */
export interface TestPlan {
	/**
	 * How many runtime test files a Partial Run selected out of the total.
	 */
	affected?: AffectedSummary | undefined;
	/**
	 * Present exactly when the plan selected nothing to do. The run must stop
	 * here — before a backend is resolved or a place is built.
	 */
	emptiness?: EmptyRunPolicy | undefined;
	/** Runtime test jobs, one per project with runtime files. */
	jobs: Array<PendingJob>;
	/**
	 * Every runtime file across every job — the coverage display-filter input.
	 */
	matchedRuntimeFiles: Array<string>;
	/**
	 * Stub source: the Clean Place takes `snapshotFormat` only from stubs.
	 */
	projects: Array<ResolvedProjectConfig>;
	/** Type Test entries, one per project with Type Tests. */
	typeTestEntries: Array<TypecheckGroupEntry>;
}

/**
 * The project set and filters every discovery pass in one run shares.
 * `buildTestPlan` adds the place the jobs will execute against.
 */
export interface RunDiscovery extends DiscoveryFilters {
	/** File system to discover on. */
	fileSystem: FileSystem;
	/** Seams the run reaches outside itself through. */
	seams: RunSeams;
	/** Profiler of the run. */
	timing: TimingCollector;
}

/**
 * What a plan is built from. The place its jobs execute against is not among
 * them: a coverage run has yet to build the one they will use, so
 * {@link bindTestPlanToPlace} aims them at it once it exists.
 */
export type TestPlanInput = RunDiscovery;

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
	/** Absolute source files of a Partial Run; absent on any other run. */
	partialRun: PartialRun | undefined;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

interface DiscoveryInput extends DiscoveryFilters {
	fileSystem: FileSystem;
	filterRelated: RelatedFileFilter | undefined;
	seams: RunSeams;
}

interface PlannedProject {
	job?: PendingJob | undefined;
	project: ResolvedProjectConfig;
	runtimeCandidateCount: number;
	typeTestEntry?: TypecheckGroupEntry | undefined;
}

/**
 * `DiscoveryInput` plus the run's `rootDir`→`outDir` rewrites. Kept local to
 * the plan: the mappings only place a discovered TS source under the mount that
 * owns it, so nothing downstream of `buildTestPlan` has any use for them.
 */
interface ProjectPlanInput extends DiscoveryInput {
	tsconfigCache: TsconfigMappingCache;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}

interface PlannedProjectInput {
	input: ProjectPlanInput;
	project: ResolvedProjectConfig;
	selection: ProjectSelection;
	typecheck: ResolvedTypecheckConfig;
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
 *
 * @param input - Projects, filters, seams and profiler.
 * @param input.timing - Profiler of the run.
 * @returns The jobs, Type Test entries and the empty-run policy.
 */
export function buildTestPlan({ timing, ...discovery }: TestPlanInput): TestPlan {
	const filterRelated = createPlanRelatedFilter(discovery, timing);
	const collected = timing.profile("collectPendingJobs", () => {
		return collectPendingJobs({ ...discovery, filterRelated });
	});
	const { jobs, projects, typeTestEntries } = collected;
	assertTypecheckAvailable(typeTestEntries);

	const matchedRuntimeFiles = jobs.flatMap((job) => job.runtimeFiles);
	const plan: TestPlan = {
		...summarizeAffected({
			affected: matchedRuntimeFiles.length,
			partialRun: discovery.partialRun,
			rootDirectory: discovery.rootConfig.rootDir,
			total: collected.runtimeCandidateCount,
		}),
		jobs,
		matchedRuntimeFiles,
		projects,
		typeTestEntries,
	};
	if (jobs.length > 0 || typeTestEntries.length > 0) {
		return plan;
	}

	return { ...plan, emptiness: toEmptyRunPolicy(discovery) };
}

/**
 * The same plan, aimed at the place its jobs will actually execute against.
 *
 * A plan is built before the run stages anything, so that one selecting nothing
 * stops the run before a backend is resolved or a place is built. The
 * instrumented place a coverage run puts in the way does not exist yet at that
 * point, and the place reaches a job through its config and nowhere else — so
 * this is the only writer of it, and aiming the jobs afterwards is the whole of
 * the difference.
 *
 * @param plan - Plan built before staging.
 * @param placeFile - Place the jobs execute against.
 * @returns The plan with each job's config pointed at the place.
 */
export function bindTestPlanToPlace(plan: TestPlan, placeFile: string): TestPlan {
	return {
		...plan,
		jobs: plan.jobs.map((job) => ({ ...job, config: { ...job.config, placeFile } })),
	};
}

function toEmptyRunPolicy({
	partialRun,
	rootConfig,
}: Pick<DiscoveryFilters, "partialRun" | "rootConfig">): EmptyRunPolicy {
	if (!rootConfig.passWithNoTests) {
		return { validationExitCode: 2, validationMessage: "No test files found in any project\n" };
	}

	if (partialRun === undefined) {
		return {};
	}

	const reached =
		partialRun.kind === "changed"
			? `the files changed since ${partialRun.since}`
			: "the related files";
	return { validationMessage: `No test files reach ${reached}, exiting with code 0\n` };
}

function createPlanRelatedFilter(
	{ fileSystem, partialRun }: Pick<DiscoveryInput, "fileSystem" | "partialRun">,
	timing: TimingCollector,
): RelatedFileFilter | undefined {
	return partialRun === undefined
		? undefined
		: createRelatedFileFilter({
				fileSystem,
				parser: luauParser,
				relatedFiles: partialRun.files,
				timing,
			});
}

function summarizeAffected({
	affected,
	partialRun,
	rootDirectory,
	total,
}: Except<AffectedSummary, "cause"> & {
	partialRun: DiscoveryFilters["partialRun"];
	rootDirectory: string;
}): Pick<TestPlan, "affected"> {
	if (partialRun === undefined) {
		return {};
	}

	const cause: PartialRunCause =
		partialRun.kind === "changed"
			? { kind: "changed", since: partialRun.since }
			: {
					files: partialRun.files.map((file) => {
						return normalizeWindowsPath(path.relative(rootDirectory, file));
					}),
					kind: "related",
				};
	return { affected: { affected, cause, total } };
}

/**
 * A Studio run serves the user's own place, where Rojo syncs any user config
 * at a mount, so the runtime injector must not parent a second `jest.config`
 * there.
 *
 * @param options - File system, project and root directory.
 * @param options.fileSystem - File system to check for user-authored configs.
 * @param options.project - Project whose mounts are checked.
 * @param options.rootDirectory - Root directory the mount paths resolve against.
 * @returns DataModel paths of the mounts without a user-authored config.
 */
function collectRuntimeInjectionPaths({
	fileSystem,
	project,
	rootDirectory,
}: {
	fileSystem: FileSystem;
	project: ResolvedProjectConfig;
	rootDirectory: string;
}): Array<string> {
	return mountsWithoutUserConfig({ fileSystem, mounts: project.rojoMounts, rootDirectory }).map(
		(mount) => mount.dataModelPath,
	);
}

function planRuntimeJob({
	input,
	project,
	selection,
}: Except<PlannedProjectInput, "typecheck">): Except<PlannedProject, "runtimeCandidateCount"> {
	const { fileSystem, rootConfig } = input;
	const { config } = buildProjectJob({
		cache: input.tsconfigCache,
		fileSystem,
		project: { config: selection.config, testFiles: selection.runtimeFiles },
		tsconfigReader: input.seams.tsconfigReader,
	});
	return {
		job: {
			config,
			displayColor: project.displayColor,
			displayName: project.displayName,
			runtimeFiles: selection.runtimeFiles,
			runtimeInjectionPaths: collectRuntimeInjectionPaths({
				fileSystem,
				project,
				rootDirectory: rootConfig.rootDir,
			}),
		},
		project: {
			...project,
			config: { ...project.config, snapshotFormat: config.snapshotFormat },
		},
	};
}

/**
 * Turn one project's selected files into the work it contributes: a type-test
 * entry, a runtime job, either, or neither.
 *
 * Each project carries its own effective `(tsconfig, cwd)` into the type pass;
 * `groupTypecheckPassesAsync` collapses projects sharing one and checks
 * distinct tsconfigs separately. The cwd is always the workspace root in
 * projects mode (all projects build from one tree).
 *
 * @param planned - Plan input, project, selection and typecheck config.
 * @param planned.input - Plan input of the run.
 * @param planned.project - Resolved project.
 * @param planned.selection - Files the project selected.
 * @param planned.typecheck - Resolved typecheck config of the project.
 * @returns The project, its job and Type Test entry, when present.
 */
function toPlannedProject({
	input,
	project,
	selection,
	typecheck,
}: PlannedProjectInput): PlannedProject {
	const planned: PlannedProject = {
		...(selection.runtimeFiles.length > 0
			? planRuntimeJob({ input, project, selection })
			: { project }),
		runtimeCandidateCount: selection.runtimeCandidateCount,
	};
	if (selection.typeTestFiles.length > 0) {
		planned.typeTestEntry = {
			cwd: input.rootConfig.rootDir,
			files: selection.typeTestFiles,
			tsconfig: typecheck.tsconfig,
		};
	}

	return planned;
}

function planProject(project: ResolvedProjectConfig, input: ProjectPlanInput): PlannedProject {
	// When auto-pick produced a per-project file subset, only feed those files
	// into discovery / narrowing for this project. Otherwise (no positional
	// files, or explicit `--project`), fall back to the full cli.files list.
	const projectCliFiles = input.filesByProject?.get(project.displayName) ?? input.cliFiles;
	const typecheck = resolveTypecheckConfig({
		cli: input.cliTypecheck,
		project: project.typecheck,
		root: input.rootConfig.typecheck,
	});
	const selection = selectProjectFiles({
		fileSystem: input.fileSystem,
		filterRelated: input.filterRelated,
		project,
		projectCliFiles,
		// Each project resolves against its OWN mounts, so one shared resolver
		// would let a mount claim a file that compiles into a different project.
		// The two bases differ when a project overrides `rootDir` (not a
		// project-only key): discovery relativizes files against that, while the
		// mounts and tsconfigs come from the run root.
		toInstancePath: createInstancePathResolver({
			mountBase: input.rootConfig.rootDir,
			mounts: project.rojoMounts,
			rootDirectory: project.config.rootDir,
			tsconfigMappings: input.tsconfigMappings,
		}),
		typecheck,
	});

	return toPlannedProject({ input, project, selection, typecheck });
}

function collectPendingJobs(
	input: DiscoveryInput,
): Pick<TestPlan, "jobs" | "projects" | "typeTestEntries"> & { runtimeCandidateCount: number } {
	const jobs: Array<PendingJob> = [];
	const projects: Array<ResolvedProjectConfig> = [];
	const typeTestEntries: Array<TypecheckGroupEntry> = [];
	const tsconfigCache = createTsconfigMappingCache();
	// One read for the whole plan rather than one per project: every project
	// resolves its tsconfigs from the same run root.
	const planInput: ProjectPlanInput = {
		...input,
		tsconfigCache,
		tsconfigMappings: resolveAllTsconfigMappings({
			cache: tsconfigCache,
			fileSystem: input.fileSystem,
			projectRoot: input.rootConfig.rootDir,
			tsconfigReader: input.seams.tsconfigReader,
		}),
	};

	let runtimeCandidateCount = 0;
	for (const project of input.projects) {
		const planned = planProject(project, planInput);
		runtimeCandidateCount += planned.runtimeCandidateCount;
		projects.push(planned.project);
		if (planned.typeTestEntry !== undefined) {
			typeTestEntries.push(planned.typeTestEntry);
		}

		if (planned.job !== undefined) {
			jobs.push(planned.job);
		}
	}

	return { jobs, projects, runtimeCandidateCount, typeTestEntries };
}
