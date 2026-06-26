import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import { extractStaticRoot } from "./projects.ts";

const DRIVE_LETTER_ABSOLUTE = /^[A-Za-z]:\//;

export interface ProjectFileMatch {
	/**
	 * The subset of cli files whose absolute path falls under one of the
	 * project's include roots. Preserves the original cli argument form so
	 * downstream consumers can still resolve relative to `rootDirectory`.
	 */
	matchingFiles: Array<string>;
	project: ResolvedProjectConfig;
}

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
 * Pair each project with the subset of cli files whose include roots own them.
 * Used so a positional file arg can auto-pick its owning project without
 * forcing the user to pass `--project`, and so each project only sees the
 * files it actually owns (no leaking type-test files or runtime files across
 * projects).
 *
 * Containment is decided by static-root prefix matching: each include
 * pattern's directory prefix (everything before the first glob char) is
 * resolved against `rootDirectory`, and a file matches when its absolute path
 * falls under that prefix. Patterns with no static root (e.g. bare
 * `**\/*.spec.ts`) are skipped — they carry no project boundary we can test
 * against. The caller can fall back to passing `--project` explicitly for
 * those cases.
 *
 * Cross-platform: paths are normalized via the shared `normalizeWindowsPath`
 * helper (backslash → forward slash, drive letter upper-cased) and joined
 * with `path.posix`. This avoids Node's platform-dependent `path.resolve`
 * behavior, so `D:/repo/...` and `/repo/...` both resolve correctly
 * regardless of where the CLI is running.
 */
export function filterProjectsByFiles(
	projects: ReadonlyArray<ResolvedProjectConfig>,
	files: ReadonlyArray<string>,
	rootDirectory: string,
): Array<ProjectFileMatch> {
	const posixRootDirectory = normalizeWindowsPath(rootDirectory);
	const absoluteFiles = files.map((file) => resolveAgainst(posixRootDirectory, file));

	const allRoots: Array<string> = [];
	const matches: Array<ProjectFileMatch> = [];

	for (const project of projects) {
		const projectRoots = collectProjectRoots(project, posixRootDirectory);
		allRoots.push(...projectRoots);

		const matchingFiles: Array<string> = [];
		for (const [index, absoluteFile] of absoluteFiles.entries()) {
			const isInRoot = projectRoots.some(
				(root) => absoluteFile === root || absoluteFile.startsWith(`${root}/`),
			);
			if (isInRoot) {
				// eslint-disable-next-line ts/no-non-null-assertion -- index aligns with absoluteFiles
				matchingFiles.push(files[index]!);
			}
		}

		if (matchingFiles.length > 0) {
			matches.push({ matchingFiles, project });
		}
	}

	if (matches.length === 0) {
		throw new Error(buildNoMatchMessage(files, allRoots));
	}

	return matches;
}

function isPosixOrDriveAbsolute(value: string): boolean {
	return value.startsWith("/") || DRIVE_LETTER_ABSOLUTE.test(value);
}

/**
 * Join `rootDirectory` and `file` into a posix path. Treats both forward-slash
 * absolutes (`/repo/...`) and drive-letter absolutes (`D:/repo/...`) as
 * absolute, regardless of host platform. Relative paths are posix-joined to
 * the root.
 */
function resolveAgainst(posixRootDirectory: string, file: string): string {
	const normalizedFile = normalizeWindowsPath(file);
	if (isPosixOrDriveAbsolute(normalizedFile)) {
		return normalizedFile;
	}

	return path.posix.join(posixRootDirectory, normalizedFile);
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
