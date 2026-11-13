import * as path from "node:path";

import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import { extractStaticRoot } from "./projects.ts";

/** A project with the directory its include patterns resolve against. */
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
	/** Base a relative cli file resolves against. */
	fileBase: string;
	/** Cli files as typed. */
	files: ReadonlyArray<string>;
	/** Scopes to match the files against. */
	scopes: ReadonlyArray<ProjectScope>;
}

interface MatchedFile {
	absolute: string;
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
			// No static prefix: the pattern gives no root to test.
		}
	}

	return roots;
}

/**
 * Pair each scope with the cli files its include roots own.
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
		if (roots.length === 0 && scope.project.include.length > 0) {
			roots.push(normalizeWindowsPath(scope.rootDirectory));
		}

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

function resolveAgainst(posixRootDirectory: string, file: string): string {
	const normalizedFile = normalizeWindowsPath(file);
	if (isAbsolutePath(normalizedFile)) {
		return normalizedFile;
	}

	return path.posix.join(posixRootDirectory, normalizedFile);
}

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
			: "  (none: projects use include patterns with no static directory prefix; pass --project explicitly)";
	return `No project contains the requested file(s):\n${filesList}\n\nProject roots searched:\n${rootsList}`;
}
