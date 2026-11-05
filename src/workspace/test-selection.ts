import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions } from "../config/schema.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { createTsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { classifyTestFiles } from "../run/discovery.ts";
import type { TypecheckGroupEntry } from "../typecheck/typecheck-groups.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, globSync } from "../utils/glob.ts";
import { applyFileFilter } from "./file-filter.ts";
import { buildPendingEntry, type PendingEntry, type ProjectCliFiles } from "./pending-entry.ts";
import { applyProjectFilter, type PackageContext } from "./project-contexts.ts";
import { projectKey } from "./project-key.ts";

/**
 * Per-package Type Test reporting/runner policy, keyed by the package
 * directory (each group's `cwd`). `ignoreSourceErrors`/`spawnTimeout` are
 * package-wide — the workspace analogue of multi's run-wide root policy —
 * while the per-project tsconfig (carried on the {@link TypecheckGroupEntry})
 * drives grouping. `pkg` composes package identity onto each merged file
 * result.
 */
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

/**
 * A (package, project) pair that owns Type Tests. The type pass groups by
 * `(cwd, tsconfig)` and reports per package, so this records the project names
 * a package's type result is written under in the per-package result files.
 */
export interface TypeTestProject {
	/** Package name. */
	pkg: string;
	/** Project display name. */
	project: string;
}

/**
 * Everything the runner needs to decide what runs: the surviving
 * `filteredContexts` (after `--project`), the runtime `pending` jobs, the Type
 * Test groups, and the per-package "no tests found" errors the caller reports
 * before bailing.
 */
export interface WorkspaceTestSelection {
	/** One error per empty package that does not pass with no tests. */
	emptyPackageErrors: Array<string>;
	/** Contexts left after the `--project` filter. */
	filteredContexts: Array<PackageContext>;
	/** Runtime jobs to dispatch. */
	pending: Array<PendingEntry>;
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
	/**
	 * Base a relative positional file resolves against — the directory the CLI
	 * was invoked from, which need not be the workspace root the run discovered
	 * above it.
	 */
	cwd: string;
	/** Where discovery globs and reads tsconfigs. Defaults to the real one. */
	fileSystem?: FileSystem;
}

interface DiscoveredTests {
	pending: Array<PendingEntry>;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
}

interface PendingEntriesInput {
	cli: CliOptions;
	contexts: Array<PackageContext>;
	filesByProject: ReadonlyMap<string, Array<string>>;
	fileSystem: FileSystem;
}

interface PackageEntriesInput {
	cliTypecheck: TypecheckCliOptions;
	ctx: PackageContext;
	filesByProject: ReadonlyMap<string, Array<string>>;
	fileSystem: FileSystem;
	globCache: GlobCache;
	packageTypecheck: ResolvedTypecheckConfig;
	tsconfigCache: TsconfigMappingCache;
}

interface ProjectTypeTestInput {
	cliFiles: ProjectCliFiles;
	ctx: PackageContext;
	fileSystem: FileSystem;
	globCache: GlobCache;
	packageTypecheck: ResolvedTypecheckConfig;
	project: ResolvedProjectConfig;
	typecheck: ResolvedTypecheckConfig;
}

/** What the `-d` glob for one project reads, and what it reads it through. */
type TypeTestDiscoveryInput = Pick<
	ProjectTypeTestInput,
	"fileSystem" | "globCache" | "project" | "typecheck"
>;

/**
 * Each package decides independently. A package with zero discovered tests
 * passes only when its OWN `passWithNoTests` is true; the workspace root's value
 * is not aggregated over packages. Projects with zero tests inside a populated
 * package are silently dropped.
 * @param input - CLI options, contexts, invocation directory and file system.
 * @returns The selected contexts, runtime jobs and Type Test groups.
 * @throws {Error} When a project name or positional file matches nothing.
 */
export function selectWorkspaceTests({
	cli,
	contexts,
	cwd,
	fileSystem = nodeFileSystem,
}: WorkspaceSelectionInput): WorkspaceTestSelection {
	// Files after names: `--project` says which projects may run at all, and a
	// positional then picks from what survived. Reversing the two would let a
	// file re-admit a project the user had just excluded by name.
	//
	// A deliberate step past multi, which short-circuits the file filter
	// entirely once `--project` is set and hands every named project the whole
	// file list unchecked. Here the two compose, so naming a file none of those
	// projects owns is the same error as naming one no package owns — a
	// workspace has enough packages that the alternative, running the file
	// under a project whose mounts cannot see it, reads as a silent pass.
	const { contexts: filteredContexts, filesByProject } = applyFileFilter({
		contexts: applyProjectFilter(contexts, cli.project),
		cwd,
		files: cli.files,
	});
	const discovered = collectPendingEntries({
		cli,
		contexts: filteredContexts,
		filesByProject,
		fileSystem,
	});
	const typeTestPackages = new Set(
		Array.from(discovered.typecheckByDirectory.values(), (entry) => entry.pkg),
	);
	const policy = applyEmptyPackagePolicy({
		allEntries: discovered.pending,
		contexts: filteredContexts,
		typeTestPackages,
	});

	return {
		emptyPackageErrors: policy.emptyPackageErrors,
		filteredContexts,
		pending: policy.pending,
		typecheckByDirectory: discovered.typecheckByDirectory,
		typeTestEntries: discovered.typeTestEntries,
		typeTestProjects: discovered.typeTestProjects,
	};
}

function applyEmptyPackagePolicy({
	allEntries,
	contexts,
	typeTestPackages,
}: {
	readonly allEntries: Array<PendingEntry>;
	readonly contexts: Array<PackageContext>;
	readonly typeTestPackages: ReadonlySet<string>;
}): Pick<WorkspaceTestSelection, "emptyPackageErrors" | "pending"> {
	const passByPackage = new Map<string, boolean>();
	for (const ctx of contexts) {
		passByPackage.set(ctx.info.name, ctx.pkgConfig.passWithNoTests);
	}

	const entriesByPackage = Map.groupBy(allEntries, (entry) => entry.pkg);

	const emptyPackageErrors: Array<string> = [];
	const pending: Array<PendingEntry> = [];
	for (const [packageName, entries] of entriesByPackage) {
		const populated = entries.filter((entry) => entry.testFiles.length > 0);
		if (populated.length > 0) {
			pending.push(...populated);
			continue;
		}

		// A package whose only tests are Type Tests (no runtime specs, or
		// `--typecheckOnly`) is NOT empty — its type pass still reports. Mirrors
		// multi's `projectResults.length === 0 && typecheckResult !== undefined`
		// valid-result branch.
		if (passByPackage.get(packageName) === true || typeTestPackages.has(packageName)) {
			continue;
		}

		emptyPackageErrors.push(`No test files found in package ${packageName}`);
	}

	return { emptyPackageErrors, pending };
}

/**
 * Per-(package, project) Type Test discovery, mirroring multi's
 * `collectPendingJobs`: derive the `-d` include from the project's Runtime
 * `include` (unless an explicit `test.typecheck.include` is set), glob it
 * against the package directory, classify by `isTypeTestFile`, then subtract
 * `test.typecheck.exclude`. Returns absolute paths so `runTypecheck` reads them
 * cwd-independently (workspace mode runs from any directory) while still keying
 * each file result package-relative against `rootDir = packageDirectory`.
 * @param input - File system, glob cache, project and typecheck config.
 * @param packageDirectory - Package directory to glob against.
 * @returns Absolute paths of the project's Type Test files.
 */
function discoverProjectTypeTests(
	{ fileSystem, globCache, project, typecheck }: TypeTestDiscoveryInput,
	packageDirectory: string,
): Array<string> {
	const include = typecheck.include ?? deriveTypecheckInclude(project.include);
	const found = include.flatMap((pattern) => {
		return globSync(pattern, { cache: globCache, cwd: packageDirectory, fileSystem });
	});

	const { typeTestFiles } = classifyTestFiles([...new Set(found)], typecheck);
	return applyExcludes(typeTestFiles, typecheck.exclude).map((file) => {
		return path.resolve(packageDirectory, file);
	});
}

function recordProjectTypeTests(
	{
		cliFiles,
		ctx,
		fileSystem,
		globCache,
		packageTypecheck,
		project,
		typecheck,
	}: ProjectTypeTestInput,
	{ typecheckByDirectory, typeTestEntries, typeTestProjects }: DiscoveredTests,
): void {
	const { packageDirectory } = ctx.info;

	// A named positional selects the type pass too, or `--workspace foo.spec.ts`
	// would still check every Type Test in the package it landed in.
	//
	// Re-resolved rather than taken as-is: ownership matching hands back posix
	// paths (see `normalizeWindowsPath`), while `discoverProjectTypeTests`
	// returns platform-native ones, and both halves feed the same tsgo group.
	const typeTestFiles =
		cliFiles?.typeTestFiles.map((file) => path.resolve(packageDirectory, file)) ??
		discoverProjectTypeTests({ fileSystem, globCache, project, typecheck }, packageDirectory);
	if (typeTestFiles.length === 0) {
		return;
	}

	typeTestProjects.push({ pkg: ctx.info.name, project: project.displayName });

	// cwd is the PACKAGE directory (not the workspace root): distinct
	// packages form distinct `(cwd, tsconfig)` groups even when they
	// share the same relative tsconfig name, while projects within a
	// package that share a tsconfig collapse to one tsgo pass.
	typeTestEntries.push({
		cwd: packageDirectory,
		files: typeTestFiles,
		tsconfig: typecheck.tsconfig,
	});
	typecheckByDirectory.set(packageDirectory, {
		ignoreSourceErrors: packageTypecheck.ignoreSourceErrors,
		pkg: ctx.info.name,
		spawnTimeout: packageTypecheck.spawnTimeout,
		timeout: ctx.pkgConfig.timeout,
	});
}

function collectPackageProjectEntries(
	{
		cliTypecheck,
		ctx,
		filesByProject,
		fileSystem,
		globCache,
		packageTypecheck,
		tsconfigCache,
	}: PackageEntriesInput,
	accumulators: DiscoveredTests,
): void {
	for (const project of ctx.projects) {
		const typecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: ctx.pkgConfig.typecheck,
		});
		const named = filesByProject.get(projectKey(ctx.info.name, project.displayName));
		const cliFiles = named === undefined ? undefined : classifyTestFiles(named, typecheck);
		accumulators.pending.push(
			buildPendingEntry({
				cliFiles,
				ctx,
				fileSystem,
				globCache,
				project,
				tsconfigCache,
				typecheck,
			}),
		);

		// Stryker disable next-line ConditionalExpression: perf only
		if (typecheck.enabled) {
			recordProjectTypeTests(
				{ cliFiles, ctx, fileSystem, globCache, packageTypecheck, project, typecheck },
				accumulators,
			);
		}
	}
}

/**
 * The four accumulators one selection fills, all empty.
 * @returns Empty accumulators.
 */
function emptyDiscoveredTests(): DiscoveredTests {
	return {
		pending: [],
		typecheckByDirectory: new Map<string, PackageTypecheck>(),
		typeTestEntries: [],
		typeTestProjects: [],
	};
}

function collectPendingEntries({
	cli,
	contexts,
	filesByProject,
	fileSystem,
}: PendingEntriesInput): DiscoveredTests {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};
	const discovered = emptyDiscoveredTests();
	// Every project in a package globs the same package directory, for runtime
	// specs and again for Type Tests. One cache for the whole selection turns
	// that 2N-walk fan into one walk per package directory.
	const globCache = createGlobCache();
	// Same shape one layer over: every project in a package rebases its files
	// through that package's tsconfigs, so the directory scan behind them
	// happens once per package rather than once per narrowed project. Threaded
	// as a cache rather than hoisted to a per-package `const` so the scan stays
	// lazy — a run with no `testPathPattern` narrows nothing and reads no
	// tsconfig at all.
	const tsconfigCache = createTsconfigMappingCache();

	for (const ctx of contexts) {
		// `ignoreSourceErrors`/`spawnTimeout` are package-wide (no project
		// layer); the per-project resolution below only drives
		// enabled/include/exclude and the grouping tsconfig.
		const packageTypecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			root: ctx.pkgConfig.typecheck,
		});

		collectPackageProjectEntries(
			{
				cliTypecheck,
				ctx,
				filesByProject,
				fileSystem,
				globCache,
				packageTypecheck,
				tsconfigCache,
			},
			discovered,
		);
	}

	return discovered;
}
