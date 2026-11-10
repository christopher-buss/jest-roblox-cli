import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { EmptyRunPolicy, PlanScope, TestsPlan } from "../discovery/test-plan.ts";
import { ANY_PROJECT_EMPTY, planTests } from "../discovery/test-plan.ts";
import type { ConfiguredJob } from "../executor/executor-types.ts";
import { buildPlannedJob } from "../executor/planned-job.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { PartialRun } from "../related/partial-run.ts";
import { mountsWithoutUserConfig } from "../staging/stub-files.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigMappingCache } from "../tsconfig/tsconfig-mappings.ts";
import type { TypecheckGroupEntry } from "../typecheck/typecheck-groups.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { RunSeams } from "./seams.ts";

/** The work a run does, before any place is bound. */
export interface TestPlan {
	/** Totals precede selection; absent for a full run. */
	affected?: import("../formatters/shared.ts").AffectedSummary | undefined;
	/** Present when nothing is selected; the run stops before a backend. */
	emptiness?: EmptyRunPolicy | undefined;
	/** Runtime test jobs, one per project with runtime files. */
	jobs: Array<ConfiguredJob>;
	/** Every runtime file across every job. */
	matchedRuntimeFiles: Array<string>;
	/** Stubs: the Clean Place reads `snapshotFormat` only from them. */
	projects: Array<ResolvedProjectConfig>;
	/** Tsconfig mappings the jobs were built against. */
	tsconfigCache: TsconfigMappingCache;
	/** Type Test entries, one per project with Type Tests. */
	typeTestEntries: Array<TypecheckGroupEntry>;
}

/** The project set and filters every discovery pass in one run shares. */
export interface RunDiscovery extends DiscoveryFilters {
	/** File system to discover on. */
	fileSystem: FileSystem;
	/** Stage reporter of the run. */
	progress: RunProgress;
	/** Seams the place build and discovery reach outside the run through. */
	seams: Pick<RunSeams, "childProcess" | "tsconfigReader">;
	/** Profiler of the run. */
	timing: TimingCollector;
}

interface DiscoveryFilters {
	cliFiles: Array<string> | undefined;
	cliTypecheck: TypecheckCliOptions;
	filesByProject?: ReadonlyMap<string, Array<string>> | undefined;
	partialRun: PartialRun | undefined;
	projects: Array<ResolvedProjectConfig>;
	rootConfig: ResolvedConfig;
}

/**
 * Turn a selected project set into runtime jobs and Type Test entries.
 * Setup paths must already be resolved.
 * @param input - Projects, filters, seams and profiler.
 * @returns The jobs, Type Test entries and the empty-run policy.
 */
export function buildTestPlan(input: RunDiscovery): TestPlan {
	return input.timing.profile("collectPendingJobs", () => {
		const planned = planTests({
			cliTypecheck: input.cliTypecheck,
			fileSystem: input.fileSystem,
			partialRun: input.partialRun,
			scopes: [toPlanScope(input)],
			summaryRoot: input.rootConfig.rootDir,
			timing: input.timing,
			tsconfigReader: input.seams.tsconfigReader,
		});
		return {
			...collectJobs(input, planned),
			affected: planned.affected,
			emptiness: planned.emptiness,
			tsconfigCache: planned.tsconfigCache,
			typeTestEntries: planned.typeTestEntries,
		};
	});
}

function toPlanScope({ cliFiles, filesByProject, projects, rootConfig }: RunDiscovery): PlanScope {
	return {
		emptyMessage: ANY_PROJECT_EMPTY,
		passWithNoTests: rootConfig.passWithNoTests,
		projects: projects.map((project) => {
			return {
				cliFiles: filesByProject?.get(project.displayName) ?? cliFiles,
				config: { ...project.config, projects: project.projects },
				project,
			};
		}),
		rootDirectory: rootConfig.rootDir,
		typecheck: rootConfig.typecheck,
	};
}

function collectJobs(
	{ fileSystem, rootConfig, seams, timing }: RunDiscovery,
	{ scopes, tsconfigCache }: TestsPlan,
): Pick<TestPlan, "jobs" | "matchedRuntimeFiles" | "projects"> {
	const jobs: Array<ConfiguredJob> = [];
	const projects = scopes
		.flatMap((scope) => scope.projects)
		.map((planned) => {
			if (planned.runtimeFiles.length === 0) {
				return planned.project;
			}

			const { job, project } = buildPlannedJob({
				fileSystem,
				planned,
				runnerTiming: timing.enabled,
				runtimeInjectionPaths: mountsWithoutUserConfig({
					fileSystem,
					mounts: planned.project.rojoMounts,
					rootDirectory: rootConfig.rootDir,
				}).map((mount) => mount.dataModelPath),
				tsconfigCache,
				tsconfigReader: seams.tsconfigReader,
			});
			jobs.push(job);
			return project;
		});
	return { jobs, matchedRuntimeFiles: jobs.flatMap((job) => job.testFiles), projects };
}
