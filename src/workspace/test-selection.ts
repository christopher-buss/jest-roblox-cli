import * as path from "node:path";

import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type {
	ResolvedTypecheckConfig,
	TypecheckCliOptions,
} from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { classifyTestFiles } from "../run/discovery.ts";
import type { TypecheckGroupEntry } from "../typecheck/group-by-tsconfig.ts";
import { createGlobCache, type GlobCache, globSync } from "../utils/glob.ts";
import { applyProjectFilter, type PackageContext } from "./project-contexts.ts";

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

interface DiscoveredTests {
	pending: Array<PendingEntry>;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
}

interface PackageEntriesInput {
	cliTypecheck: TypecheckCliOptions;
	ctx: PackageContext;
	globCache: GlobCache;
	packageTypecheck: ResolvedTypecheckConfig;
}

interface ProjectTypeTestInput {
	ctx: PackageContext;
	globCache: GlobCache;
	packageTypecheck: ResolvedTypecheckConfig;
	project: ResolvedProjectConfig;
	typecheck: ResolvedTypecheckConfig;
}

// Each package decides independently. A package with zero discovered tests
// passes only when its OWN `passWithNoTests` is true; the workspace root's value
// is not aggregated over packages. Projects with zero tests inside a populated
// package are silently dropped.
export function selectWorkspaceTests(
	contexts: Array<PackageContext>,
	cli: CliOptions,
): WorkspaceTestSelection {
	const filteredContexts = applyProjectFilter(contexts, cli.project);
	const discovered = collectPendingEntries(filteredContexts, cli);
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
): Array<string> {
	const found: Array<string> = [];
	for (const pattern of project.include) {
		found.push(...globSync(pattern, { cache: globCache, cwd: packageDirectory }));
	}

	// Workspace mode never consumes positional file args (no auto-pick path), so
	// the exclude gate is unconditional — there is no user-chosen file set to
	// bypass. Runtime discovery globs the Runtime `include` only; Type Tests are
	// discovered separately by `discoverProjectTypeTests` from the `-d` include.
	return applyExcludes([...new Set(found)], project.exclude);
}

// Per-(package, project) Type Test discovery, mirroring multi's
// `collectPendingJobs`: derive the `-d` include from the project's Runtime
// `include` (unless an explicit `test.typecheck.include` is set), glob it
// against the package directory, classify by `TYPE_TEST_PATTERN`, then subtract
// `test.typecheck.exclude`. Returns absolute paths so `runTypecheck` reads them
// cwd-independently (workspace mode runs from any directory) while still keying
// each file result package-relative against `rootDir = packageDirectory`.
function discoverProjectTypeTests(
	project: ResolvedProjectConfig,
	typecheck: ResolvedTypecheckConfig,
	packageDirectory: string,
	globCache: GlobCache,
): Array<string> {
	const include = typecheck.include ?? deriveTypecheckInclude(project.include);
	const found: Array<string> = [];
	for (const pattern of include) {
		found.push(...globSync(pattern, { cache: globCache, cwd: packageDirectory }));
	}

	const { typeTestFiles } = classifyTestFiles([...new Set(found)], typecheck);
	return applyExcludes(typeTestFiles, typecheck.exclude).map((file) => {
		return path.resolve(packageDirectory, file);
	});
}

function recordProjectTypeTests(
	{ ctx, globCache, packageTypecheck, project, typecheck }: ProjectTypeTestInput,
	{ typecheckByDirectory, typeTestEntries, typeTestProjects }: DiscoveredTests,
): void {
	const { packageDirectory } = ctx.info;

	const typeTestFiles = discoverProjectTypeTests(project, typecheck, packageDirectory, globCache);
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
	{ cliTypecheck, ctx, globCache, packageTypecheck }: PackageEntriesInput,
	accumulators: DiscoveredTests,
): void {
	const { packageDirectory } = ctx.info;

	for (const project of ctx.projects) {
		const typecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			project: project.typecheck,
			root: ctx.pkgConfig.typecheck,
		});
		const projectConfig = buildProjectExecutionConfig(ctx.pkgConfig, project);
		// `--typecheckOnly` / per-project `only` means "don't run runtime
		// tests": zero the runtime file set so the package contributes only
		// Type Tests (the short-circuit then skips the place build +
		// dispatch).
		const testFiles = typecheck.only
			? []
			: discoverProjectTestFiles(project, packageDirectory, globCache);
		accumulators.pending.push({ pkg: ctx.info.name, project, projectConfig, testFiles });

		if (typecheck.enabled) {
			recordProjectTypeTests(
				{ ctx, globCache, packageTypecheck, project, typecheck },
				accumulators,
			);
		}
	}
}

function collectPendingEntries(contexts: Array<PackageContext>, cli: CliOptions): DiscoveredTests {
	const cliTypecheck: TypecheckCliOptions = {
		enabled: cli.typecheck,
		only: cli.typecheckOnly,
		tsconfig: cli.typecheckTsconfig,
	};
	const pending: Array<PendingEntry> = [];
	const typeTestEntries: Array<TypecheckGroupEntry> = [];
	const typeTestProjects: Array<TypeTestProject> = [];
	const typecheckByDirectory = new Map<string, PackageTypecheck>();
	// Every project in a package globs the same package directory, for runtime
	// specs and again for Type Tests. One cache for the whole selection turns
	// that 2N-walk fan into one walk per package directory.
	const globCache = createGlobCache();

	for (const ctx of contexts) {
		// `ignoreSourceErrors`/`spawnTimeout` are package-wide (no project
		// layer); the per-project resolution below only drives
		// enabled/include/exclude and the grouping tsconfig.
		const packageTypecheck = resolveTypecheckConfig({
			cli: cliTypecheck,
			root: ctx.pkgConfig.typecheck,
		});

		collectPackageProjectEntries(
			{ cliTypecheck, ctx, globCache, packageTypecheck },
			{ pending, typecheckByDirectory, typeTestEntries, typeTestProjects },
		);
	}

	return { pending, typecheckByDirectory, typeTestEntries, typeTestProjects };
}
