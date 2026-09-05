import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import { createInstancePathResolver } from "../config/instance-path.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import {
	createTsconfigMappingCache,
	resolveAllTsconfigMappings,
} from "../executor/tsconfig-mappings.ts";
import type { ClassifiedTestFiles } from "../run/discovery.ts";
import { classifyTestFiles, filterByTestPathPattern } from "../run/discovery.ts";
import type { TypecheckGroupEntry } from "../typecheck/group-by-tsconfig.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, type GlobCache, globSync } from "../utils/glob.ts";
import { applyFileFilter } from "./file-filter.ts";
import { applyProjectFilter, type PackageContext } from "./project-contexts.ts";
import { projectKey } from "./project-key.ts";

export interface PendingEntry {
	pkg: string;
	project: ResolvedProjectConfig;
	projectConfig: ResolvedConfig;
	testFiles: Array<string>;
}

/**
 * Per-package Type Test reporting/runner policy, keyed by the package
 * directory (each group's `cwd`). `ignoreSourceErrors`/`spawnTimeout` are
 * package-wide — the workspace analogue of multi's run-wide root policy —
 * while the per-project tsconfig (carried on the {@link TypecheckGroupEntry})
 * drives grouping. `pkg` composes package identity onto each merged file
 * result.
 */
export interface PackageTypecheck {
	ignoreSourceErrors?: boolean | undefined;
	pkg: string;
	spawnTimeout?: number | undefined;
	/** Run-level `timeout` (package-wide); bounds the tsgo compile. */
	timeout: number;
}

// A (package, project) pair that owns Type Tests. The type pass groups by
// `(cwd, tsconfig)` and reports per package, so this records the project names a
// package's type result is written under in the per-package result files.
export interface TypeTestProject {
	pkg: string;
	project: string;
}

/**
 * Everything the runner needs to decide what runs: the surviving
 * `filteredContexts` (after `--project`), the runtime `pending` jobs, the Type
 * Test groups, and the per-package "no tests found" errors the caller reports
 * before bailing.
 */
export interface WorkspaceTestSelection {
	emptyPackageErrors: Array<string>;
	filteredContexts: Array<PackageContext>;
	pending: Array<PendingEntry>;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
}

export interface WorkspaceSelectionInput {
	cli: CliOptions;
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

/**
 * The positional files this project owns, absolute and already split into the
 * two halves discovery splits its own glob into — or `undefined` when the run
 * named no files, which is what leaves discovery globbing.
 *
 * Classified once, where the files are looked up, rather than at each consumer:
 * `classifyTestFiles` is the rule that decides which half a file belongs to,
 * and running it again downstream would let the dispatched file set and the
 * Luau pattern disagree about a file. `undefined` and "both halves empty"
 * differ — no project reaches here in the latter state, because the file filter
 * drops one that matches nothing before the entry is built.
 */
type ProjectCliFiles = ClassifiedTestFiles | undefined;

interface PendingEntryInput {
	cliFiles: ProjectCliFiles;
	ctx: PackageContext;
	fileSystem: FileSystem;
	globCache: GlobCache;
	project: ResolvedProjectConfig;
	tsconfigCache: TsconfigMappingCache;
	typecheck: ResolvedTypecheckConfig;
}

interface ProjectNarrowInput {
	fileSystem: FileSystem;
	/**
	 * Set when the narrow came from positionals. Half of the `filterActive`
	 * condition multi computes in `selectProjectFiles`; the other half — a
	 * `--testPathPattern` — is already on `projectConfig`.
	 */
	isPositional: boolean;
	packageDirectory: string;
	project: ResolvedProjectConfig;
	projectConfig: ResolvedConfig;
	testFiles: Array<string>;
	tsconfigCache: TsconfigMappingCache;
	typecheck: ResolvedTypecheckConfig;
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

// Each package decides independently. A package with zero discovered tests
// passes only when its OWN `passWithNoTests` is true; the workspace root's value
// is not aggregated over packages. Projects with zero tests inside a populated
// package are silently dropped.
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
	const policy = applyEmptyPackagePolicy(discovered.pending, filteredContexts, typeTestPackages);

	return {
		emptyPackageErrors: policy.emptyPackageErrors,
		filteredContexts,
		pending: policy.pending,
		typecheckByDirectory: discovered.typecheckByDirectory,
		typeTestEntries: discovered.typeTestEntries,
		typeTestProjects: discovered.typeTestProjects,
	};
}

function applyEmptyPackagePolicy(
	allEntries: Array<PendingEntry>,
	contexts: Array<PackageContext>,
	typeTestPackages: ReadonlySet<string>,
): Pick<WorkspaceTestSelection, "emptyPackageErrors" | "pending"> {
	const passByPackage = new Map<string, boolean>();
	for (const ctx of contexts) {
		passByPackage.set(ctx.info.name, ctx.pkgConfig.passWithNoTests);
	}

	const entriesByPackage = new Map<string, Array<PendingEntry>>();
	for (const entry of allEntries) {
		let group = entriesByPackage.get(entry.pkg);
		if (group === undefined) {
			group = [];
			entriesByPackage.set(entry.pkg, group);
		}

		group.push(entry);
	}

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

// Per-(package, project) Type Test discovery, mirroring multi's
// `collectPendingJobs`: derive the `-d` include from the project's Runtime
// `include` (unless an explicit `test.typecheck.include` is set), glob it
// against the package directory, classify by `TYPE_TEST_PATTERN`, then subtract
// `test.typecheck.exclude`. Returns absolute paths so `runTypecheck` reads them
// cwd-independently (workspace mode runs from any directory) while still keying
// each file result package-relative against `rootDir = packageDirectory`.
function discoverProjectTypeTests(
	{ fileSystem, globCache, project, typecheck }: TypeTestDiscoveryInput,
	packageDirectory: string,
): Array<string> {
	const include = typecheck.include ?? deriveTypecheckInclude(project.include);
	const found: Array<string> = [];
	for (const pattern of include) {
		found.push(...globSync(pattern, { cache: globCache, cwd: packageDirectory, fileSystem }));
	}

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

function buildProjectExecutionConfig(
	packageConfig: ResolvedConfig,
	project: ResolvedProjectConfig,
): ResolvedConfig {
	return {
		...project.config,
		passWithNoTests: packageConfig.passWithNoTests,
		projects: project.projects,
		rootDir: packageConfig.rootDir,
		testMatch: project.testMatch,
	};
}

function discoverProjectTestFiles(
	project: ResolvedProjectConfig,
	packageDirectory: string,
	globCache: GlobCache,
	fileSystem: FileSystem,
): Array<string> {
	const found: Array<string> = [];
	for (const pattern of project.include) {
		found.push(...globSync(pattern, { cache: globCache, cwd: packageDirectory, fileSystem }));
	}

	// Runtime discovery globs the Runtime `include` only; Type Tests are
	// discovered separately by `discoverProjectTypeTests` from the `-d` include.
	return applyExcludes([...new Set(found)], project.exclude);
}

/**
 * Resolve this project's filter — positional files, or a `--testPathPattern` —
 * against its discovered files Node-side, then forward an Instance-namespace
 * pattern (see {@link narrowForLuauRun}).
 *
 * Narrowed per project rather than per package so the mounts come from
 * `project.rojoMounts` — the same include-filtered, ancestor-pruned,
 * `outDir`-pinned set multi narrows against. A raw walk of the package's Rojo
 * tree would answer with whichever mount sits deepest on disk instead, so the
 * two modes would translate one file to two different sub-paths.
 *
 * Positionals have already selected `testFiles`, so they need no second pass
 * here; they beat a `--testPathPattern` given alongside them, as they do in
 * multi. A pattern that matches nothing in this project simply targets another
 * one: keep the (zero-matching) raw pattern so Jest-on-Roblox runs nothing,
 * and set `passWithNoTests` so it doesn't `exit(1)`. The raw pattern is
 * load-bearing here — clearing it would drop the filter entirely and make the
 * Luau side fall back to `testMatch`, running the whole project.
 */
function narrowProjectFilter({
	fileSystem,
	isPositional,
	packageDirectory,
	project,
	projectConfig,
	testFiles,
	tsconfigCache,
	typecheck,
}: ProjectNarrowInput): ResolvedConfig {
	if (!isPositional && projectConfig.testPathPattern === undefined) {
		return projectConfig;
	}

	const runtimeFiles = isPositional
		? testFiles
		: classifyTestFiles(
				filterByTestPathPattern(testFiles, projectConfig.testPathPattern),
				typecheck,
			).runtimeFiles;
	if (runtimeFiles.length === 0) {
		return { ...projectConfig, passWithNoTests: true };
	}

	return narrowForLuauRun({
		config: projectConfig,
		filterActive: true,
		runtimeFiles,
		// One base, not two: `discoverProjectTestFiles` globs the package
		// directory, and `resolveAllProjects` reads the mounts and the tsconfigs
		// from there too, so the project's `rootDir` never enters this
		// translation.
		toInstancePath: createInstancePathResolver({
			mountBase: packageDirectory,
			mounts: project.rojoMounts,
			rootDirectory: packageDirectory,
			tsconfigMappings: resolveAllTsconfigMappings(
				packageDirectory,
				tsconfigCache,
				fileSystem,
			),
		}),
	});
}

function buildPendingEntry({
	cliFiles,
	ctx,
	fileSystem,
	globCache,
	project,
	tsconfigCache,
	typecheck,
}: PendingEntryInput): PendingEntry {
	const { packageDirectory } = ctx.info;
	// Positionals skip the glob and the `exclude` gate both — they are
	// user-chosen and already classified. Only the glob branch has to zero
	// itself for `--typecheckOnly` (per-project `only`): `classifyTestFiles`
	// already emptied the positional half.
	//
	// The rule matches multi's `selectProjectFiles`, but the discovery around
	// it does not, which is why the two are not one function: multi globs one
	// `testMatch` covering both runtime and `-d` files and splits the result,
	// while a package globs its Runtime `include` and its derived `-d` include
	// separately — deliberately, so coverage-source derivation never sees a
	// `-d` glob (see `discoverProjectTypeTests`). Only the decision is shared,
	// through `classifyTestFiles` and `narrowForLuauRun`.
	const testFiles =
		cliFiles?.runtimeFiles ??
		(typecheck.only
			? []
			: discoverProjectTestFiles(project, packageDirectory, globCache, fileSystem));

	return {
		pkg: ctx.info.name,
		project,
		projectConfig: narrowProjectFilter({
			fileSystem,
			isPositional: cliFiles !== undefined,
			packageDirectory,
			project,
			projectConfig: buildProjectExecutionConfig(ctx.pkgConfig, project),
			testFiles,
			tsconfigCache,
			typecheck,
		}),
		testFiles,
	};
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

		if (typecheck.enabled) {
			recordProjectTypeTests(
				{ cliFiles, ctx, fileSystem, globCache, packageTypecheck, project, typecheck },
				accumulators,
			);
		}
	}
}

/** The four accumulators one selection fills, all empty. */
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
