import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import {
	resolveTypecheckConfig,
	toTypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import type { CliOptions } from "../config/resolved-config.ts";
import { selectProjectScopes } from "../discovery/project-selector.ts";
import type { EmptyRunPolicy, PlannedScope, PlanScope } from "../discovery/test-plan.ts";
import { planTests } from "../discovery/test-plan.ts";
import type { ConfiguredJob } from "../executor/executor-types.ts";
import { buildPlannedJob, type PlannedJobInput } from "../executor/planned-job.ts";
import type { TsconfigMappingCache, TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { TypecheckGroupEntry } from "../typecheck/typecheck-groups.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageContext } from "./project-contexts.ts";
import { projectKey } from "./project-key.ts";

/** One (package, project) pair that has runtime tests to dispatch. */
export interface PendingEntry {
	/** The job the backend runs. */
	job: WorkspaceJob;
	/** Project within the package, with its resolved `snapshotFormat`. */
	project: ResolvedProjectConfig;
}

/** Per-package Type Test policy. */
export interface PackageTypecheck {
	/** Whether to ignore errors outside the Type Test files. */
	ignoreSourceErrors?: boolean | undefined;
	/** Package name. */
	pkg: string;
	/** Time limit for the type checker process, in milliseconds. */
	spawnTimeout?: number | undefined;
	/** Run-level `timeout` (package-wide); bounds the tsgo compile. */
	timeout: number;
}

/** A (package, project) pair that owns Type Tests. */
export interface TypeTestProject {
	/** Package name. */
	pkg: string;
	/** Project display name. */
	project: string;
}

/** What a workspace run selected to run. */
export interface WorkspaceTestSelection {
	/** Totals precede selection; absent for a full run. */
	affected?: import("../formatters/shared.ts").AffectedSummary | undefined;
	/**
	 * Narrows mapped coverage while instrumentation retains its full cache
	 * universe.
	 */
	changedFiles?: ReadonlyArray<string> | undefined;
	/** Present exactly when the run selected nothing it may run. */
	emptiness?: EmptyRunPolicy | undefined;
	/** Contexts left after the `--project` filter. */
	filteredContexts: Array<PackageContext>;
	/** Runtime jobs to dispatch. */
	pending: Array<PendingEntry>;
	/** Tsconfig mappings read while selecting. */
	tsconfigCache: TsconfigMappingCache;
	/** Type Test policy per package directory. */
	typecheckByDirectory: Map<string, PackageTypecheck>;
	/** Type Test files to group. */
	typeTestEntries: Array<TypecheckGroupEntry>;
	/** Projects that own Type Tests. */
	typeTestProjects: Array<TypeTestProject>;
}

/** CLI options and contexts to select tests from. */
export interface WorkspaceSelectionInput {
	/** CLI options that filter projects and files. */
	cli: CliOptions;
	/** Resolved package contexts. */
	contexts: Array<PackageContext>;
	/** Base a relative positional file resolves against. */
	cwd: string;
	/** Where discovery globs and reads tsconfigs. */
	fileSystem: FileSystem;
	/** The same file set scopes discovery and mapped coverage. */
	partialRun?: import("../related/partial-run.ts").PartialRun | undefined;
	/** Have the runner report its phase timings. */
	runnerTiming: boolean;
	/** Graph construction records its own phase on this collector. */
	timing?: import("../timing/orchestration-collector.ts").TimingCollector | undefined;
	/** Reads a tsconfig. */
	tsconfigReader: TsconfigReader;
	/** Workspace base for partial-run summary paths. */
	workspaceRoot: string;
}

/** A dispatch job carrying the package it belongs to. */
interface WorkspaceJob extends ConfiguredJob {
	/** Package name. */
	pkg: string;
}

interface PackageScope extends PlanScope {
	ctx: PackageContext;
}

type PlannedPackage = PlannedScope<PackageScope>;

/**
 * Select every package's tests, each package one planning scope.
 * @param input - CLI options, contexts, invocation directory and readers.
 * @returns The selected contexts, runtime jobs and Type Test groups.
 * @throws {Error} When a project name or positional file matches nothing.
 */
export function selectWorkspaceTests({
	cli,
	contexts,
	cwd,
	fileSystem,
	partialRun,
	runnerTiming,
	timing,
	tsconfigReader,
	workspaceRoot,
}: WorkspaceSelectionInput): WorkspaceTestSelection {
	const { filesByProject, filteredContexts } = selectContexts({ cli, contexts, cwd });
	const cliTypecheck = toTypecheckCliOptions(cli);
	const plan = planTests({
		cliTypecheck,
		fileSystem,
		partialRun,
		scopes: filteredContexts.map((ctx) => toPlanScope(ctx, filesByProject)),
		summaryRoot: workspaceRoot,
		timing,
		tsconfigReader,
	});

	return {
		affected: plan.affected,
		changedFiles: partialRun?.files,
		emptiness: plan.emptiness,
		filteredContexts,
		pending: plan.scopes.flatMap((planned) => {
			return toPendingEntries(planned, {
				fileSystem,
				runnerTiming,
				tsconfigCache: plan.tsconfigCache,
				tsconfigReader,
			});
		}),
		tsconfigCache: plan.tsconfigCache,
		...collectTypeTests(plan.scopes, cliTypecheck),
		typeTestEntries: plan.typeTestEntries,
	};
}

function selectedFilesByProject(
	filteredContexts: Array<PackageContext>,
	selected: ReturnType<typeof selectProjectScopes>,
): ReadonlyMap<string, Array<string>> {
	const filesByProject = new Map<string, Array<string>>();
	for (const ctx of filteredContexts) {
		for (const match of selected) {
			if (match.files !== undefined && ctx.projects.includes(match.scope.project)) {
				filesByProject.set(
					projectKey(ctx.info.name, match.scope.project.displayName),
					match.files,
				);
			}
		}
	}

	return filesByProject;
}

function selectContexts({
	cli,
	contexts,
	cwd,
}: Pick<WorkspaceSelectionInput, "cli" | "contexts" | "cwd">): {
	filesByProject: ReadonlyMap<string, Array<string>>;
	filteredContexts: Array<PackageContext>;
} {
	const selected = selectProjectScopes({
		fileBase: cwd,
		files: cli.files,
		names: cli.project,
		scopes: contexts.flatMap((ctx) => {
			return ctx.projects.map((project) => {
				return {
					project,
					rootDirectory: ctx.info.packageDirectory,
				};
			});
		}),
	});
	if (cli.project === undefined && (cli.files === undefined || cli.files.length === 0)) {
		return { filesByProject: new Map(), filteredContexts: contexts };
	}

	const projects = new Set(selected.map(({ scope }) => scope.project));
	const filteredContexts = contexts
		.map((ctx) => {
			return { ...ctx, projects: ctx.projects.filter((project) => projects.has(project)) };
		})
		.filter((ctx) => ctx.projects.length > 0);
	return { filesByProject: selectedFilesByProject(filteredContexts, selected), filteredContexts };
}

function toPlanScope(
	ctx: PackageContext,
	filesByProject: ReadonlyMap<string, Array<string>>,
): PackageScope {
	return {
		ctx,
		emptyMessage: `No test files found in package ${ctx.info.name}\n`,
		passWithNoTests: ctx.pkgConfig.passWithNoTests,
		projects: ctx.projects.map((project) => {
			return {
				cliFiles: filesByProject.get(projectKey(ctx.info.name, project.displayName)),
				config: {
					...project.config,
					passWithNoTests: ctx.pkgConfig.passWithNoTests,
					projects: project.projects,
					rootDir: ctx.pkgConfig.rootDir,
				},
				project,
			};
		}),
		rootDirectory: ctx.info.packageDirectory,
		typecheck: ctx.pkgConfig.typecheck,
	};
}

function toPendingEntries(
	{ projects, scope: { ctx } }: PlannedPackage,
	seams: Pick<
		PlannedJobInput,
		"fileSystem" | "runnerTiming" | "tsconfigCache" | "tsconfigReader"
	>,
): Array<PendingEntry> {
	const packageName = ctx.info.name;
	return projects
		.filter(({ runtimeFiles }) => runtimeFiles.length > 0)
		.map((planned) => {
			const { job, project } = buildPlannedJob({ ...seams, planned });
			return { job: { ...job, pkg: packageName }, project };
		});
}

function collectTypeTests(
	packages: Array<PlannedPackage>,
	cli: TypecheckCliOptions,
): Pick<WorkspaceTestSelection, "typecheckByDirectory" | "typeTestProjects"> {
	const typecheckByDirectory = new Map<string, PackageTypecheck>();
	const typeTestProjects: Array<TypeTestProject> = [];
	for (const {
		projects,
		scope: { ctx },
	} of packages) {
		const owners = projects.filter(({ typeTestFiles }) => typeTestFiles.length > 0);
		if (owners.length === 0) {
			continue;
		}

		for (const { project } of owners) {
			typeTestProjects.push({ pkg: ctx.info.name, project: project.displayName });
		}

		const packageTypecheck = resolveTypecheckConfig({ cli, root: ctx.pkgConfig.typecheck });
		typecheckByDirectory.set(ctx.info.packageDirectory, {
			ignoreSourceErrors: packageTypecheck.ignoreSourceErrors,
			pkg: ctx.info.name,
			spawnTimeout: packageTypecheck.spawnTimeout,
			timeout: ctx.pkgConfig.timeout,
		});
	}

	return { typecheckByDirectory, typeTestProjects };
}
