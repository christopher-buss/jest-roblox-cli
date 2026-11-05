import * as path from "node:path";

import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import { extractStaticRoot } from "./projects.ts";

/** A project with the cli files it owns. */
export interface ProjectFileMatch {
	/**
	 * The subset of cli files whose absolute path falls under one of the
	 * project's include roots. Preserves the original cli argument form so
	 * downstream consumers can still resolve relative to `rootDirectory`.
	 */
	matchingFiles: Array<string>;
	/** Project that owns the files. */
	project: ResolvedProjectConfig;
}

/**
 * A project together with the directory its include patterns resolve against.
 *
 * The two travel as a pair because the modes disagree about the second half:
 * multi resolves every project against one run root, while workspace resolves
 * each against its own package directory.
 */
export interface ProjectScope {
	/** Project in scope. */
	project: ResolvedProjectConfig;
	/** Directory the project's include patterns resolve against. */
	rootDirectory: string;
}

/** A scope with the cli files its include roots own. */
export interface ProjectScopeMatch {
	/** Owned files. */
	files: Array<MatchedFile>;
	/** Scope that owns them. */
	scope: ProjectScope;
}

/** Input to `matchFilesToProjects`. */
export interface ProjectFileMatching {
	/**
	 * Base a relative cli file resolves against. Separate from the scopes' own
	 * roots because a positional is typed relative to the invocation directory,
	 * which in workspace mode is not any package's directory. Multi passes its
	 * run root for both, which is this same call with the two coincident.
	 */
	fileBase: string;
	/** Cli files as typed. */
	files: ReadonlyArray<string>;
	/** Scopes to match the files against. */
	scopes: ReadonlyArray<ProjectScope>;
}

/** One cli file a set of include roots owns, in both forms a caller needs. */
interface MatchedFile {
	/** Absolute and posix-normalized, ready to hand straight to discovery. */
	absolute: string;
	/**
	 * The cli argument as typed. Multi mode re-resolves it against each
	 * project's own `rootDir`, which is not always the base it matched against.
	 */
	original: string;
}

/**
 * Resolve a project's static include roots against a root directory.
 *
 * @param project - Project whose include patterns to read.
 * @param posixRootDirectory - Posix root the include roots resolve against.
 * @returns Absolute posix roots; patterns with no static prefix are skipped.
 */
export function collectProjectRoots(
	project: ResolvedProjectConfig,
	posixRootDirectory: string,
): Array<string> {
	const roots: Array<string> = [];
	for (const pattern of project.include) {
		try {
			const { root } = extractStaticRoot(normalizeWindowsPath(pattern));
			roots.push(resolveAgainst(posixRootDirectory, root));
		} catch {
			// Pattern has no static directory prefix — cannot test containment,
			// so this project is excluded from auto-pick. Caller can still pass
			// --project explicitly.
		}
	}

	return roots;
}

/**
 * Pair each scope with the cli files its include roots own, and reject the
 * files nothing owns.
 *
 * The one place ownership is decided, for both dispatch modes. Containment is
 * static-root prefix matching: each include pattern's directory prefix
 * (everything before the first glob char) is resolved against the scope's
 * `rootDirectory`, and a file matches when its absolute path falls under that
 * prefix. Patterns with no static root (such as bare `**\/*.spec.ts`) are skipped
 * — they carry no project boundary to test against, so the caller falls back to
 * naming a project explicitly.
 *
 * Cross-platform: paths are normalized via the shared `normalizeWindowsPath`
 * helper (backslash → forward slash, drive letter upper-cased) and joined with
 * `path.posix`. This avoids Node's platform-dependent `path.resolve` behavior,
 * so `D:/repo/...` and `/repo/...` both resolve correctly regardless of where
 * the CLI is running.
 *
 * @param matching - File base, cli files and scopes.
 * @returns Each scope that owns at least one file, with its files.
 * @throws If no scope owns any of the files.
 */
export function matchFilesToProjects({
	fileBase,
	files,
	scopes,
}: ProjectFileMatching): Array<ProjectScopeMatch> {
	const matcher = createFileMatcher(files, fileBase);
	const allRoots: Array<string> = [];
	const matches: Array<ProjectScopeMatch> = [];

	for (const scope of scopes) {
		const roots = collectProjectRoots(scope.project, normalizeWindowsPath(scope.rootDirectory));
		allRoots.push(...roots);

		const matched = matcher(roots);
		if (matched.length > 0) {
			matches.push({ files: matched, scope });
		}
	}

	if (matches.length === 0) {
		throw new Error(buildNoMatchMessage(files, allRoots));
	}

	return matches;
}

/**
 * Multi's view of {@link matchFilesToProjects}: every project resolves against
 * the one run root, and each keeps its cli files in the form they were typed so
 * discovery can re-resolve them against the project's own `rootDir`.
 *
 * Used so a positional file arg can auto-pick its owning project without
 * forcing the user to pass `--project`, and so each project only sees the files
 * it actually owns (no leaking type-test files or runtime files across
 * projects).
 *
 * @param options - Cli files, projects and the run root.
 * @returns Each project that owns at least one file, with its files as typed.
 * @throws If no project owns any of the files.
 */
export function filterProjectsByFiles({
	files,
	projects,
	rootDirectory,
}: {
	readonly files: ReadonlyArray<string>;
	readonly projects: ReadonlyArray<ResolvedProjectConfig>;
	readonly rootDirectory: string;
}): Array<ProjectFileMatch> {
	const scopes = projects.map((project) => ({ project, rootDirectory }));

	return matchFilesToProjects({ fileBase: rootDirectory, files, scopes }).map((match) => {
		return {
			matchingFiles: match.files.map((entry) => entry.original),
			project: match.scope.project,
		};
	});
}

/**
 * Join `rootDirectory` and `file` into a posix path. Treats both forward-slash
 * absolutes (`/repo/...`) and drive-letter absolutes (`D:/repo/...`) as
 * absolute, regardless of host platform. Relative paths are posix-joined to
 * the root.
 *
 * @param posixRootDirectory - Posix root for relative paths.
 * @param file - Path to resolve.
 * @returns The posix path.
 */
function resolveAgainst(posixRootDirectory: string, file: string): string {
	const normalizedFile = normalizeWindowsPath(file);
	if (isAbsolutePath(normalizedFile)) {
		return normalizedFile;
	}

	return path.posix.join(posixRootDirectory, normalizedFile);
}

/**
 * Tests one fixed list of cli files against whatever include roots it is asked
 * about. Built once per walk: resolving those files to absolute form is the
 * whole of the setup, and every scope after the first re-uses it.
 *
 * @param files - Cli files as typed.
 * @param base - Directory relative files resolve against.
 * @returns A function that selects the files under any given root.
 */
function createFileMatcher(
	files: ReadonlyArray<string>,
	base: string,
): (roots: ReadonlyArray<string>) => Array<MatchedFile> {
	const posixBase = normalizeWindowsPath(base);
	const resolved = files.map((file) => {
		return { absolute: resolveAgainst(posixBase, file), original: file };
	});

	return function select(roots) {
		return resolved.filter(({ absolute }) => {
			return roots.some((root) => absolute === root || absolute.startsWith(`${root}/`));
		});
	};
}

function buildNoMatchMessage(files: ReadonlyArray<string>, roots: ReadonlyArray<string>): string {
	const filesList = files.map((file) => `  - ${normalizeWindowsPath(file)}`).join("\n");
	const uniqueRoots = [...new Set(roots)];
	const rootsList =
		uniqueRoots.length > 0
			? uniqueRoots.map((root) => `  - ${root}`).join("\n")
			: "  (none — projects use include patterns with no static directory prefix; pass --project explicitly)";
	return `No project contains the requested file(s):\n${filesList}\n\nProject roots searched:\n${rootsList}`;
}
