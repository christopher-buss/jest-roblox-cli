import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { matchesGlobPattern } from "../utils/glob.ts";
import { isWithinRoot, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { findWorkspaceRoot } from "../workspace/workspace-root.ts";

/** Where a changed file can matter to a Partial Run, as absolute paths. */
export interface ChangeScope {
	/** Globs relative to `workspaceRoot`; a match selects every test. */
	forceRerunTriggers: ReadonlyArray<string>;
	/** Root of the project the run tests. */
	projectRoot: string;
	/** Every `$path` mount of the project's Rojo tree. */
	rojoRoots: ReadonlyArray<string>;
	/** Root the `forceRerunTriggers` globs are relative to. */
	workspaceRoot: string;
}

/**
 * What one changed file means to a Partial Run, before the graph is read.
 *
 * - `trigger`: matches `forceRerunTriggers`.
 * - `module`: a Luau ModuleScript in the Rojo tree.
 * - `opaque`: any other file in the project root or the Rojo tree.
 * - `ignored`: outside all of them.
 */
export type ChangeKind = "ignored" | "module" | "opaque" | "trigger";

/** Inputs of {@link resolveChangeScope}. */
export interface ChangeScopeInput {
	/** File system the workspace markers are looked up on. */
	fileSystem: FileSystem;
	/** Globs relative to the workspace root. */
	forceRerunTriggers: ReadonlyArray<string>;
	/** Root of the project the run tests. */
	projectRoot: string;
	/** Every absolute `$path` mount of the project's Rojo tree. */
	rojoRoots: Iterable<string>;
}

const LUAU_FILE = /\.luau?$/;
const LUAU_SCRIPT = /\.(?:client|server)\.luau?$/;

/**
 * Settle the roots a Partial Run classifies its changed files against. The
 * workspace root is the nearest folder at or above the project root with a
 * pnpm, turbo or nx marker, else the project root.
 *
 * @param input - File system, triggers, project root and Rojo mounts.
 * @returns The scope, with every root absolute and `/`-separated.
 */
export function resolveChangeScope({
	fileSystem,
	forceRerunTriggers,
	projectRoot,
	rojoRoots,
}: ChangeScopeInput): ChangeScope {
	const root = path.resolve(projectRoot);
	return {
		forceRerunTriggers,
		projectRoot: normalizeWindowsPath(root),
		rojoRoots: Array.from(rojoRoots, (mount) => normalizeWindowsPath(path.resolve(mount))),
		workspaceRoot: normalizeWindowsPath(findWorkspaceRoot(root, fileSystem) ?? root),
	};
}

/**
 * Classify one changed file against a scope.
 *
 * @param scope - Roots and triggers of the run.
 * @param file - Absolute, `/`-separated path of the changed file.
 * @returns What the change means to the run.
 */
export function classifyChange(scope: ChangeScope, file: string): ChangeKind {
	const fromWorkspace = path.posix.relative(scope.workspaceRoot, file);
	const isTrigger =
		isWithinRoot(file, scope.workspaceRoot) &&
		scope.forceRerunTriggers.some((pattern) => matchesGlobPattern(fromWorkspace, pattern));
	if (isTrigger) {
		return "trigger";
	}

	if (scope.rojoRoots.some((root) => isWithinRoot(file, root))) {
		return LUAU_FILE.test(file) && !LUAU_SCRIPT.test(file) ? "module" : "opaque";
	}

	return isWithinRoot(file, scope.projectRoot) ? "opaque" : "ignored";
}
