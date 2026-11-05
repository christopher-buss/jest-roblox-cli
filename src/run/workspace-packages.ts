import assert from "node:assert";
import process from "node:process";

import type { CliOptions, WorkspaceConfig } from "../config/schema.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { resolveWorkspacePackages } from "./workspace-validation.ts";

/** Outcome of {@link resolvePackages}. */
export interface ResolvedPackages {
	/** Exit code `2` and the message when resolution failed. */
	error?: {
		/** Exit code of the failed run. */
		exitCode: 2;
		/** Message for stderr. */
		message: string;
	};
	/** Set when `--affected-since` selected no package. */
	noAffected?: true | undefined;
	/** The selected packages. */
	packageInfos?: Array<PackageInfo> | undefined;
	/** Absolute workspace root directory. */
	workspaceRoot?: string | undefined;
}

interface EnumerationRoot {
	exclude?: Array<string> | undefined;
	patterns?: Array<string> | undefined;
	workspaceRoot: string;
}

/**
 * Resolve the workspace root and the packages a workspace run selects.
 *
 * @param options - CLI options, dependencies and workspace config.
 * @param options.cli - Parsed command-line options.
 * @param options.dependencies - Child process runner and file system.
 * @param options.dependencies.childProcess - Runs the change detector.
 * @param options.dependencies.fileSystem - File system to enumerate.
 * @param options.workspace - The `workspace` config block, if any.
 * @returns The selected packages and root, `noAffected`, or an error.
 */
export function resolvePackages({
	cli,
	dependencies: { childProcess, fileSystem },
	workspace,
}: {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Child process runner and file system. */
	dependencies: {
		/** Runs the change detector. */
		childProcess: ChildProcessRunner;
		/** File system to enumerate. */
		fileSystem: FileSystem;
	};
	/** The `workspace` config block, if any. */
	workspace: undefined | WorkspaceConfig;
}): ResolvedPackages {
	try {
		const { exclude, patterns, workspaceRoot } = resolveEnumerationRoot(fileSystem, workspace);
		const packageInfos = resolveWorkspacePackages({
			childProcess,
			cli,
			exclude,
			fileSystem,
			patterns,
			workspaceRoot,
		});

		if (packageInfos.length === 0) {
			// Two ways to select nothing, and they mean opposite things. A
			// change-detected set can legitimately be empty; a workspace with
			// no testable package in it is a misconfiguration, and reporting it
			// as a clean run would hide that behind a green exit.
			return cli.affectedSince !== undefined
				? { noAffected: true }
				: { error: { exitCode: 2, message: emptyWorkspaceMessage(patterns) } };
		}

		return { packageInfos, workspaceRoot };
	} catch (err) {
		return { error: { exitCode: 2, message: `Error: ${String(err)}\n` } };
	}
}

/**
 * `workspace.packages` (declared in a shared config, anchored absolute root)
 * enumerates packages by globbing for jest configs — no package-manager
 * workspace file required. Falls back to discovering a pnpm/turbo/nx root.
 *
 * @param fileSystem - File system for root discovery.
 * @param workspace - The `workspace` config block, if any.
 * @returns Root, package globs and excludes to enumerate with.
 */
function resolveEnumerationRoot(
	fileSystem: FileSystem,
	workspace?: WorkspaceConfig,
): EnumerationRoot {
	if (workspace?.packages !== undefined) {
		// The schema's co-requirement check guarantees `root` is present, and
		// the loader resolved it to an absolute path at config load.
		assert(workspace.root !== undefined);
		return {
			exclude: workspace.exclude,
			patterns: workspace.packages,
			workspaceRoot: workspace.root,
		};
	}

	// `exclude` stands alone: it narrows the pnpm source too, where the root
	// comes from discovery rather than from config.
	return {
		exclude: workspace?.exclude,
		workspaceRoot: discoverWorkspaceRoot(process.cwd(), fileSystem),
	};
}

/**
 * Name the source that came up empty, since the remedy differs: a
 * `workspace.packages` list is the user's own glob to widen, while the pnpm
 * source points back at `pnpm-workspace.yaml`.
 *
 * @param patterns - The `workspace.packages` globs, or `undefined` for pnpm.
 * @returns The error message with its remedy.
 */
function emptyWorkspaceMessage(patterns: Array<string> | undefined): string {
	const source =
		patterns === undefined
			? "Widen pnpm-workspace.yaml, or declare `workspace.packages` in your jest config"
			: "Widen `workspace.packages`";
	return (
		"Error: no packages with a jest.config.* to run in this workspace.\n" +
		`${source}, and check workspace.exclude.\n`
	);
}
