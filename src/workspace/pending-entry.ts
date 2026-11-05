import { applyExcludes } from "../config/apply-excludes.ts";
import { createInstancePathResolver } from "../config/instance-path.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { TsconfigMappingCache } from "../executor/tsconfig-mappings.ts";
import { resolveAllTsconfigMappings } from "../executor/tsconfig-mappings.ts";
import type { ClassifiedTestFiles } from "../run/discovery.ts";
import { classifyTestFiles, filterByTestPathPattern } from "../run/discovery.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { type GlobCache, globSync } from "../utils/glob.ts";
import type { PackageContext } from "./project-contexts.ts";

/** One (package, project) pair that has runtime tests to dispatch. */
export interface PendingEntry {
	/** Package name. */
	pkg: string;
	/** Project within the package. */
	project: ResolvedProjectConfig;
	/** Package config with the project's narrowed filter applied. */
	projectConfig: ResolvedConfig;
	/** Runtime test files the project runs. */
	testFiles: Array<string>;
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
export type ProjectCliFiles = ClassifiedTestFiles | undefined;

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

/**
 * Discover a project's runtime test files and narrow its filter.
 * @param input - Package context, project, positional files and seams.
 * @returns The pending entry for the project.
 */
export function buildPendingEntry({
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
			: discoverProjectTestFiles({
					fileSystem,
					globCache,
					packageDirectory,
					project,
				}));

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

function discoverProjectTestFiles({
	fileSystem,
	globCache,
	packageDirectory,
	project,
}: {
	readonly fileSystem: FileSystem;
	readonly globCache: GlobCache;
	readonly packageDirectory: string;
	readonly project: ResolvedProjectConfig;
}): Array<string> {
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
 * @param input - Project, its config, its test files and seams.
 * @returns The project config with the narrowed filter.
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
			tsconfigMappings: resolveAllTsconfigMappings({
				cache: tsconfigCache,
				fileSystem,
				projectRoot: packageDirectory,
			}),
		}),
	});
}
