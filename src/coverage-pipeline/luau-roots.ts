import { collectPaths, resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";
import picomatch from "picomatch";

import type { ResolvedConfig } from "../config/schema.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../executor/tsconfig-mappings.ts";
import type { RojoProject } from "../types/rojo.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	isAbsolutePath,
	normalizeWindowsPath,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowLuauRoots } from "./narrow-roots.ts";
import {
	collectRojoMounts,
	containsMatchingFile,
	resolveMountWithin,
} from "./root-reachability.ts";

/** A rojo project this run could read, with the frame its mounts are in. */
interface RojoProjectInFrame {
	/** The project with nested projects inlined. */
	project: RojoProject;
	/** What `$path` resolves against — the project's own directory. */
	rojoDirectory: string;
}

/** One read of a rojo project: the tree, or why there is none. */
interface RojoProjectRead {
	/**
	 * The parse failure, held rather than thrown, and set only for a project
	 * too malformed to read — never for a missing one. A run that names its own
	 * `luauRoots` never needs the tree, and refusing it for a project it does
	 * not read would turn a working run into a hard failure, so only the root
	 * auto-detect rethrows this.
	 */
	failure: Error | undefined;
	/**
	 * Absent when the project is missing or too malformed to parse. The tree
	 * and the directory it is read against travel as one: a mount means
	 * nothing without the frame it resolves in.
	 */
	loaded: RojoProjectInFrame | undefined;
}

/** The rojo project a run reads, read at most once and shared by everything. */
interface RojoContext {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	/**
	 * The project, read on the first ask and remembered.
	 *
	 * Lazy rather than eager: a config that names its own `luauRoots` never
	 * looks at the tree, and reading it costs a parse of the project plus a
	 * parse of every project it nests. Multi asks this question once per
	 * project config, so the eager read spent N of those on an answer the first
	 * branch already had.
	 */
	read: () => RojoProjectRead;
	tsconfigReader: TsconfigReader;
}

/**
 * Locate the rojo project: the configured one, `default.project.json`, or the
 * first `.project.json` in `rootDir`.
 * @param config - Resolved run config.
 * @param fileSystem - File system to probe.
 * @returns Path of the project file.
 * @throws {Error} When no project is configured or found.
 */
export function findRojoProject(
	config: ResolvedConfig,
	fileSystem: FileSystem = nodeFileSystem,
): string {
	if (config.rojoProject !== undefined) {
		return config.rojoProject;
	}

	const defaultPath = path.join(config.rootDir, "default.project.json");
	if (fileSystem.existsSync(defaultPath)) {
		return defaultPath;
	}

	const files = fileSystem.readdirSync(config.rootDir, "utf-8");
	const projectFile = files.find((file) => file.endsWith(".project.json"));
	if (projectFile !== undefined) {
		return path.join(config.rootDir, projectFile);
	}

	throw new Error(
		"No Rojo project found. Set rojoProject in config or add a .project.json file.",
	);
}

/**
 * The run's luau roots from config, rojo mounts or tsconfig `outDir`, deduped
 * in canonical spelling.
 * @param options - Config, file system and tsconfig reader.
 * @returns Canonical luau roots.
 * @throws {Error} When no source supplies roots or the rojo project is
 *   malformed.
 */
export function resolveLuauRoots({
	config,
	fileSystem = nodeFileSystem,
	tsconfigReader = nodeTsconfigReader,
}: {
	config: ResolvedConfig;
	fileSystem?: FileSystem;
	tsconfigReader?: TsconfigReader;
}): Array<PosixRoot> {
	return resolveLuauRootsWithRojo(
		readRojoContext({
			config,
			fileSystem,
			rojoProjectPath: tryFindRojoProject(config, fileSystem),
			tsconfigReader,
		}),
	);
}

/**
 * {@link resolveLuauRoots}, answering none where no source says what the roots
 * are rather than refusing the run.
 *
 * That case is a run the coverage pipeline cannot serve and a Code Bundle can:
 * nothing travels, the place holds every mount, and the run costs what it
 * always did. A malformed rojo project is not that case and still throws —
 * catching it here would trade a diagnosable failure for a run that silently
 * ships no code.
 * @param options - Config, file system and tsconfig reader.
 * @returns Canonical luau roots; empty when no source supplies any.
 * @throws {Error} When the rojo project is malformed.
 */
export function tryResolveLuauRoots({
	config,
	fileSystem = nodeFileSystem,
	tsconfigReader = nodeTsconfigReader,
}: {
	config: ResolvedConfig;
	fileSystem?: FileSystem;
	tsconfigReader?: TsconfigReader | undefined;
}): Array<PosixRoot> {
	const context = readRojoContext({
		config,
		fileSystem,
		rojoProjectPath: tryFindRojoProject(config, fileSystem),
		tsconfigReader,
	});
	return dedupeRoots(findRawLuauRoots(context) ?? []);
}

/**
 * The luau roots this run instruments: the configured or auto-detected ones,
 * narrowed to the directories the coverage universe actually reaches.
 * @param options - Config, file system, copy-ignore gate, rojo project path,
 *   tsconfig reader and universe.
 * @returns Narrowed mounts.
 * @throws {Error} When no roots are found, a root is absolute, or the rojo
 *   project is malformed.
 */
export function narrowConfiguredRoots({
	config,
	fileSystem,
	isCopyIgnored,
	rojoProjectPath,
	tsconfigReader,
	universe,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	isCopyIgnored: CopyIgnoreMatcher;
	rojoProjectPath: string | undefined;
	tsconfigReader: TsconfigReader;
	universe: InstrumentUniverse | undefined;
}): Array<NarrowedMount> {
	// One read: the root auto-detect and the mount set the demote is judged
	// against both come from the same tree, nested projects included.
	const rojo = readRojoContext({ config, fileSystem, rojoProjectPath, tsconfigReader });
	const mounts = resolveLuauRootsWithRojo(rojo);

	validateRelativeRoots(mounts);

	// Narrowed before anything is instrumented: the universe resolves off
	// directory entries and source maps alone, so what comes back is what the
	// shadow has to mirror rather than every file the mount holds.
	return narrowLuauRoots(mounts, {
		fileSystem,
		isCopyIgnored,
		rojoMounts: resolveRojoMounts(rojo),
		universe,
	});
}

/**
 * {@link findRojoProject}, answering `undefined` where there is no project.
 * @param config - Resolved run config.
 * @param fileSystem - File system to probe.
 * @returns Path of the project file, or undefined.
 */
function tryFindRojoProject(config: ResolvedConfig, fileSystem: FileSystem): string | undefined {
	try {
		return findRojoProject(config, fileSystem);
	} catch {
		return undefined;
	}
}

function isLuauFile(name: string): boolean {
	return name.endsWith(".luau");
}

/**
 * The project's `$path` mounts that this run can take as coverage roots,
 * `rootDir`-relative.
 *
 * `rootDir` is the frame — `MountFrame` says why the modes share one, and here
 * it is where a root is read from by everything downstream: synthesis resolves
 * one against it, the rojo inputs hash joins one onto it, and
 * `resolveRojoMounts` states the mounts in it. A root probed in any other
 * frame, the cwd included, is one the rest of the run cannot find.
 * @param options - Project in its frame, config and file system.
 * @returns Mounted directories that hold `.luau` files and are not ignored.
 */
function collectLuauRootsFromRojo({
	config,
	fileSystem = nodeFileSystem,
	project,
	rojoDirectory,
}: RojoProjectInFrame & { config: ResolvedConfig; fileSystem?: FileSystem }): Array<string> {
	const paths: Array<string> = [];
	collectPaths(project.tree, paths);

	const ignorePatterns = config.coveragePathIgnorePatterns;
	// contains: true so bare strings like "rojo-sync" match "rojo-sync/rbxts",
	// mirroring Jest's regex-based coveragePathIgnorePatterns behavior.
	const isIgnored = picomatch(ignorePatterns, { contains: true });

	const seen = new Set<string>();
	const roots: Array<string> = [];
	for (const rawPath of paths) {
		const root = resolveMountWithin(rawPath, { frame: config.rootDir, rojoDirectory });
		// One `$path` mounted at two places in the tree is one root: taken
		// twice it is instrumented into the same shadow dir twice and named
		// twice in the manifest. Workspace mode dedupes in
		// `discoverFromRojoWalk` for the same reason.
		if (root === undefined || seen.has(root) || isIgnored(root)) {
			continue;
		}

		const directoryPath = path.resolve(config.rootDir, root);
		if (!fileSystem.existsSync(directoryPath)) {
			continue;
		}

		// Only directories can be coverage roots (skip single-file $path entries)
		if (!fileSystem.statSync(directoryPath).isDirectory()) {
			continue;
		}

		if (containsMatchingFile(fileSystem, { directoryPath, matches: isLuauFile })) {
			seen.add(root);
			roots.push(root);
		}
	}

	return roots;
}

/**
 * Auto-detect coverage roots from the Rojo project's `$path` mounts. Returns
 * `undefined` when no project file was found or it mounted nothing
 * instrumentable, so the caller falls through to the tsconfig `outDir`.
 * @param options - Config, file system and the loaded project.
 * @returns Detected roots, or undefined.
 */
function detectRootsFromRojo({
	config,
	fileSystem,
	loaded,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	loaded: RojoProjectInFrame | undefined;
}): Array<string> | undefined {
	if (loaded === undefined) {
		return undefined;
	}

	const roots = collectLuauRootsFromRojo({ ...loaded, config, fileSystem });
	return roots.length > 0 ? roots : undefined;
}

/**
 * Gets the luau roots from the first source that supplies them: the config
 * `luauRoots`, the rojo mounts, then the tsconfig `outDir`. Each root keeps
 * the spelling of its source. Use {@link resolveLuauRootsWithRojo} to get
 * corrected roots.
 *
 * `undefined` where no source supplies any — which is a run the pipeline
 * refuses and a Code Bundle merely does without, so the two verdicts are the
 * caller's to give rather than this one's.
 * @param context - Rojo context for the run.
 * @returns Roots in their source spelling, or undefined.
 * @throws {Error} The held parse failure of a malformed rojo project.
 */
function findRawLuauRoots({
	config,
	fileSystem,
	read,
	tsconfigReader,
}: RojoContext): Array<string> | undefined {
	if (config.luauRoots !== undefined && config.luauRoots.length > 0) {
		return config.luauRoots;
	}

	const { failure, loaded } = read();
	if (failure !== undefined) {
		throw failure;
	}

	const rojoRoots = detectRootsFromRojo({ config, fileSystem, loaded });
	if (rojoRoots !== undefined) {
		return rojoRoots;
	}

	const tsconfig = tsconfigReader(config.rootDir) ?? undefined;
	return tsconfig?.config.compilerOptions?.outDir === undefined
		? undefined
		: [tsconfig.config.compilerOptions.outDir];
}

/**
 * {@link findRawLuauRoots}, refusing a run that supplies none.
 * @param context - Rojo context for the run.
 * @returns Roots in their source spelling.
 * @throws {Error} When no source supplies roots.
 */
function selectRawLuauRoots(context: RojoContext): Array<string> {
	const roots = findRawLuauRoots(context);
	if (roots === undefined) {
		throw new Error(
			"Could not determine luauRoots. Set luauRoots in config or ensure tsconfig has outDir.",
		);
	}

	return roots;
}

/**
 * Roots in one spelling, so two spellings of one directory reduce to one.
 * @param roots - Roots in any spelling.
 * @returns Distinct canonical roots.
 */
function dedupeRoots(roots: ReadonlyArray<string>): Array<PosixRoot> {
	return [...new Set(roots.map(toPosixRoot))];
}

/**
 * Gets the luau roots for this run and corrects the spelling of each one. A
 * user writes the config `luauRoots` and the tsconfig `outDir` by hand, thus
 * their spelling can differ from the spelling the pipeline needs. The
 * correction is here, and not in each source, so that a new source also gets
 * it.
 *
 * Correcting the spelling is what makes the dedupe possible, and the dedupe is
 * what the correction is for: two spellings of one directory reduce to one
 * string, and the second is dropped rather than instrumented and mirrored into
 * a shadow the first already holds. Workspace mode does the same in
 * `discoverFromLuauRoots`.
 * @param context - Rojo context for the run.
 * @returns Distinct canonical roots.
 */
function resolveLuauRootsWithRojo(context: RojoContext): Array<PosixRoot> {
	return dedupeRoots(selectRawLuauRoots(context));
}

/**
 * The project with its nested `.project.json` mounts inlined, or `undefined`
 * when there is none to read. Both the root auto-detect and the mount set the
 * demote is judged against come from this one read.
 * @param fileSystem - File system to read through.
 * @param resolvedPath - Path of the project file.
 * @returns The loaded project, or the held failure for malformed JSON.
 */
function loadResolvedRojoProject(fileSystem: FileSystem, resolvedPath: string): RojoProjectRead {
	try {
		const validated = rojoProjectSchema(
			JSON.parse(fileSystem.readFileSync(resolvedPath, "utf-8")),
		);
		if (validated instanceof type.errors) {
			throw new Error(validated.summary);
		}

		const rojoDirectory = path.dirname(resolvedPath);
		const tree = resolveNestedProjects(
			{ rootDirectory: rojoDirectory, tree: validated.tree },
			fileSystem,
		);

		return {
			failure: undefined,
			loaded: { project: { ...validated, tree }, rojoDirectory },
		};
	} catch (err) {
		// Expected: nothing readable there → the caller falls through to the
		// tsconfig outDir. Unexpected: malformed JSON → held for the caller
		// that depends on the tree, to help debugging.
		return {
			failure:
				err instanceof SyntaxError
					? new Error(`Malformed Rojo project JSON: ${err.message}`, { cause: err })
					: undefined,
			loaded: undefined,
		};
	}
}

/**
 * The same read every time, however many callers ask this context for it.
 * @param read - The read to cache.
 * @returns Read that runs `read` on first call only.
 */
function readOnce(read: () => RojoProjectRead): () => RojoProjectRead {
	let cached: RojoProjectRead | undefined;
	return () => {
		cached ??= read();
		return cached;
	};
}

/**
 * What a run with no rojo project on disk reads instead of one.
 * @returns A read with neither tree nor failure.
 */
function readNoRojoProject(): RojoProjectRead {
	return { failure: undefined, loaded: undefined };
}

/**
 * {@link loadResolvedRojoProject}, read once and the failure held for later.
 * @param options - Config, file system, project path and tsconfig reader.
 * @returns Rojo context with a lazy, cached read.
 */
function readRojoContext({
	config,
	fileSystem,
	rojoProjectPath,
	tsconfigReader,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	rojoProjectPath: string | undefined;
	tsconfigReader: TsconfigReader;
}): RojoContext {
	/**
	 * No project file at all: the caller falls through to tsconfig's outDir,
	 * and there are no mounts to judge a demote against.
	 * @returns The project read.
	 */
	const read =
		rojoProjectPath === undefined
			? readNoRojoProject
			: () => loadResolvedRojoProject(fileSystem, rojoProjectPath);
	return { config, fileSystem, read: readOnce(read), tsconfigReader };
}

/**
 * `isAbsolutePath`, not `path.isAbsolute`: the latter answers for the host it
 * runs on, so `D:/repo/out` is an absolute root a developer's machine rejects
 * and a plain relative filename Linux CI accepts and instruments outside the
 * package. The roots arrive canonical, so the drive letter reads the same way
 * on both.
 * @param luauRoots - Canonical roots.
 * @throws {Error} When a root is absolute.
 */
function validateRelativeRoots(luauRoots: ReadonlyArray<PosixRoot>): void {
	for (const root of luauRoots) {
		if (isAbsolutePath(root)) {
			throw new Error(
				"luauRoots must be relative paths, got absolute path. " +
					"Set a relative outDir in tsconfig or relative luauRoots in config.",
			);
		}
	}
}

/**
 * The project's `$path` mounts, in the frame `luauRoots` are written in.
 *
 * Only a mount is a directory the demote can rewrite, and a `luauRoot` need
 * not be one — `places/main` names `out` while the project mounts
 * `out/client` and `out/server`.
 *
 * Relativized against `rootDir` because that is what synthesis resolves a
 * coverage root against, so a mount and a root agree here exactly when they
 * agree there.
 * @param context - Rojo context for the run.
 * @returns `rootDir`-relative mounts; empty when no project loaded.
 */
function resolveRojoMounts({ config, read }: RojoContext): ReadonlySet<string> {
	const { loaded } = read();
	if (loaded === undefined) {
		return new Set();
	}

	const mounts = collectRojoMounts(loaded.project.tree, loaded.rojoDirectory);
	return new Set(
		Array.from(mounts, (mount) => normalizeWindowsPath(path.relative(config.rootDir, mount))),
	);
}
