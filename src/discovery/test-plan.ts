import * as path from "node:path";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
	TypecheckConfig,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { AffectedSummary } from "../formatters/shared.ts";
import { luauParser } from "../luau/parser.ts";
import type { PartialRun } from "../related/partial-run.ts";
import type { RelatedRun } from "../related/related-run.ts";
import { createRelatedFileFilter, type RelatedFileFilter } from "../related/related-tests.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type {
	TsconfigMapping,
	TsconfigMappingCache,
	TsconfigReader,
} from "../tsconfig/tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	resolveAllTsconfigMappings,
} from "../tsconfig/tsconfig-mappings.ts";
import type { TypecheckGroupEntry } from "../typecheck/typecheck-groups.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache } from "../utils/glob.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { toTypeTestPattern } from "../utils/test-file-kind.ts";
import { createInstancePathResolver } from "./instance-path.ts";
import { selectProjectFiles } from "./project-files.ts";

/** What an empty run reports; fields match `RunResult`'s for spreading. */
export interface EmptyRunPolicy {
	/** Exit code `2` when an empty run fails. */
	validationExitCode?: 2 | undefined;
	/** Notice for stderr when an empty run fails. */
	validationMessage?: string | undefined;
}

/** A set of projects built from one Rojo tree: the run, or one package. */
export interface PlanScope {
	/** Notice for stderr when the scope found no test at all. */
	emptyMessage: string;
	/** Whether the scope passes with no tests. */
	passWithNoTests: boolean;
	/** Projects of the scope. */
	projects: Array<PlanProjectInput>;
	/** Base of the Rojo mounts and the tsconfigs, and the Type Test cwd. */
	rootDirectory: string;
	/** Root typecheck config the projects' own resolve over. */
	typecheck: TypecheckConfig | undefined;
}

/**
 * Inputs of {@link planTests}.
 * @template S - Scope type the caller plans.
 */
export interface PlanTestsInput<S extends PlanScope = PlanScope> {
	/** Typecheck flags of the CLI. */
	cliTypecheck: TypecheckCliOptions;
	/** File system to discover on. */
	fileSystem: FileSystem;
	/** The same file set scopes discovery and mapped coverage. */
	partialRun?: (Partial<Pick<RelatedRun, "scope">> & PartialRun) | undefined;
	/** Scopes to plan. */
	scopes: Array<S>;
	/** Base for paths printed in partial-run summaries. */
	summaryRoot: string;
	/** Graph construction records its own phase on this collector. */
	timing?: TimingCollector | undefined;
	/** Reads a tsconfig. */
	tsconfigReader: TsconfigReader;
}

/** One project's selected tests. */
export interface PlannedProject {
	/** Job config narrowed to the runtime files. */
	config: ResolvedConfig;
	/** The resolved project. */
	project: ResolvedProjectConfig;
	/** Runtime test files of the project. */
	runtimeFiles: Array<string>;
	/** Resolved typecheck config of the project. */
	typecheck: ResolvedTypecheckConfig;
	/** Absolute Type Test files of the project. */
	typeTestFiles: Array<string>;
}

/**
 * One scope's selected tests, a planned entry per input project.
 * @template S - Scope type the caller plans.
 */
export interface PlannedScope<S extends PlanScope = PlanScope> {
	/** Whether the scope found any test before `testPathPattern`. */
	hasFoundTests: boolean;
	/** Planned projects, in input order. */
	projects: Array<PlannedProject>;
	/** The planned scope. */
	scope: S;
	/** Counted before related selection for the Affected denominator. */
	totalRuntimeFiles: number;
}

/**
 * The tests a run selected.
 * @template S - Scope type the caller plans.
 */
export interface TestsPlan<S extends PlanScope = PlanScope> {
	/** Totals precede selection; absent for a full run. */
	affected?: AffectedSummary | undefined;
	/** Present exactly when the run selected nothing it may run. */
	emptiness?: EmptyRunPolicy | undefined;
	/** Planned scopes, in input order. */
	scopes: Array<PlannedScope<S>>;
	/** Tsconfig mappings read while planning; the jobs reuse them. */
	tsconfigCache: TsconfigMappingCache;
	/** Type Test entries, one per project with Type Tests. */
	typeTestEntries: Array<TypecheckGroupEntry>;
}

interface PlanProjectInput {
	cliFiles: ReadonlyArray<string> | undefined;
	config: ResolvedConfig;
	project: ResolvedProjectConfig;
}

interface DiscoveredProject {
	discovered: number;
	planned: PlannedProject;
	totalRuntimeFiles: number;
}

interface ResolvedProjectInput extends PlanProjectInput {
	typecheck: ResolvedTypecheckConfig;
}

interface ScopeContext {
	fileSystem: FileSystem;
	filterRelated: RelatedFileFilter | undefined;
	globCache: GlobCache;
	scope: PlanScope;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}

/** What a run that found no test anywhere reports. */
export const ANY_PROJECT_EMPTY = "No test files found in any project\n";

/**
 * Select each scope's tests, narrow job configs, and judge the empty run.
 * @template S - Scope type the caller plans.
 * @param input - Scopes, CLI typecheck flags, file system and tsconfig reader.
 * @returns The planned scopes, Type Test entries and the empty-run policy.
 */
export function planTests<S extends PlanScope>(input: PlanTestsInput<S>): TestsPlan<S> {
	const filterRelated = relatedFilter(input);
	const tsconfigCache = createTsconfigMappingCache();
	const resolved = input.scopes.map((scope) => resolveScopeProjects(input.cliTypecheck, scope));
	const globCache = createGlobCache(
		resolved.flatMap(({ projects }) => {
			return projects.flatMap(({ project, typecheck }) => {
				return discoveryPatterns(project, typecheck);
			});
		}),
	);
	const scopes = resolved.map(({ projects, scope }) => {
		const tsconfigMappings = resolveAllTsconfigMappings({
			cache: tsconfigCache,
			fileSystem: input.fileSystem,
			projectRoot: scope.rootDirectory,
			tsconfigReader: input.tsconfigReader,
		});
		return planScope(
			{ fileSystem: input.fileSystem, filterRelated, globCache, scope, tsconfigMappings },
			projects,
		);
	});

	const plan = { scopes, tsconfigCache, typeTestEntries: collectTypeTestEntries(scopes) };
	return finishPlan(input, plan);
}

function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	return runtimeInclude.map(toTypeTestPattern);
}

/**
 * Type Test globs stay out of `project.include`: coverage-source derivation
 * must never see a `-d` glob.
 *
 * @param project - Resolved project.
 * @param typecheck - Resolved typecheck config of the project.
 * @returns The globs that discover the project's tests.
 */
function discoveryPatterns(
	project: ResolvedProjectConfig,
	typecheck: ResolvedTypecheckConfig,
): Array<string> {
	return typecheck.enabled
		? [...project.include, ...(typecheck.include ?? deriveTypecheckInclude(project.include))]
		: project.include;
}

function planProject(context: ScopeContext, input: ResolvedProjectInput): DiscoveredProject {
	const { config, project, typecheck } = input;
	const selected = selectProjectFiles({
		fileSystem: context.fileSystem,
		filterRelated: context.filterRelated,
		globCache: context.globCache,
		project: { ...project, config },
		projectCliFiles: input.cliFiles === undefined ? undefined : [...input.cliFiles],
		toInstancePath: createInstancePathResolver({
			mountBase: context.scope.rootDirectory,
			mounts: project.rojoMounts,
			rootDirectory: config.rootDir,
			tsconfigMappings: context.tsconfigMappings,
		}),
		typecheck,
	});
	return {
		discovered: selected.discovered,
		planned: {
			config: selected.config,
			project,
			runtimeFiles: selected.runtimeFiles,
			typecheck,
			typeTestFiles: selected.typeTestFiles.map((file) => path.resolve(config.rootDir, file)),
		},
		totalRuntimeFiles: selected.runtimeCandidateCount,
	};
}

function planScope<S extends PlanScope>(
	context: ScopeContext & { scope: S },
	projects: Array<ResolvedProjectInput>,
): PlannedScope<S> {
	const planned = projects.map((project) => planProject(context, project));
	return {
		hasFoundTests: planned.some(({ discovered }) => discovered > 0),
		projects: planned.map((project) => project.planned),
		scope: context.scope,
		totalRuntimeFiles: planned.reduce((sum, project) => sum + project.totalRuntimeFiles, 0),
	};
}

function resolveScopeProjects<S extends PlanScope>(
	cliTypecheck: TypecheckCliOptions,
	scope: S,
): { projects: Array<ResolvedProjectInput>; scope: S } {
	const projects = scope.projects.map((input) => {
		return {
			...input,
			typecheck: resolveTypecheckConfig({
				cli: cliTypecheck,
				project: input.project.typecheck,
				root: scope.typecheck,
			}),
		};
	});
	return { projects, scope };
}

function collectTypeTestEntries(scopes: Array<PlannedScope>): Array<TypecheckGroupEntry> {
	return scopes.flatMap(({ projects, scope }) => {
		return projects
			.filter(({ typeTestFiles }) => typeTestFiles.length > 0)
			.map(({ typecheck, typeTestFiles }) => {
				return {
					cwd: scope.rootDirectory,
					files: typeTestFiles,
					tsconfig: typecheck.tsconfig,
				};
			});
	});
}

function relatedFilter(input: PlanTestsInput): RelatedFileFilter | undefined {
	return input.partialRun === undefined || input.timing === undefined
		? undefined
		: createRelatedFileFilter({
				fileSystem: input.fileSystem,
				parser: luauParser,
				relatedFiles: input.partialRun.files,
				scope: input.partialRun.scope,
				timing: input.timing,
			});
}

function judgeEmptiness({
	scopes,
	typeTestEntries,
}: Pick<TestsPlan, "scopes" | "typeTestEntries">): EmptyRunPolicy | undefined {
	const failing = scopes
		.filter(({ hasFoundTests, scope }) => !hasFoundTests && !scope.passWithNoTests)
		.map(({ scope }) => scope.emptyMessage);
	if (failing.length > 0) {
		return { validationExitCode: 2, validationMessage: failing.join("") };
	}

	const hasRuntimeFiles = scopes.some(({ projects }) => {
		return projects.some(({ runtimeFiles }) => runtimeFiles.length > 0);
	});
	if (hasRuntimeFiles || typeTestEntries.length > 0) {
		return undefined;
	}

	return scopes.every(({ scope }) => scope.passWithNoTests)
		? {}
		: { validationExitCode: 2, validationMessage: ANY_PROJECT_EMPTY };
}

function summarizeAffected(
	{ partial, root }: { partial: PartialRun; root: string },
	plan: TestsPlan,
): AffectedSummary {
	const cause =
		partial.kind === "changed"
			? { kind: partial.kind, since: partial.since }
			: {
					files: partial.files.map((file) => {
						return normalizeWindowsPath(path.relative(root, file));
					}),
					kind: partial.kind,
				};
	return {
		affected: plan.scopes
			.flatMap((scope) => scope.projects)
			.reduce((sum, project) => sum + project.runtimeFiles.length, 0),
		cause,
		total: plan.scopes.reduce((sum, scope) => sum + scope.totalRuntimeFiles, 0),
	};
}

function finishPlan<S extends PlanScope>(
	input: PlanTestsInput<S>,
	plan: TestsPlan<S>,
): TestsPlan<S> {
	const partial = input.partialRun;
	const emptiness = judgeEmptiness(plan);
	if (partial === undefined) {
		return { ...plan, emptiness };
	}

	const reached =
		partial.kind === "changed"
			? `the files changed since ${partial.since}`
			: "the related files";
	return {
		...plan,
		affected: summarizeAffected({ partial, root: input.summaryRoot }, plan),
		emptiness:
			emptiness !== undefined && emptiness.validationExitCode === undefined
				? { validationMessage: `No test files reach ${reached}, exiting with code 0\n` }
				: emptiness,
	};
}
