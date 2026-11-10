import assert from "node:assert";
import process from "node:process";

import type { WorkspaceConfig } from "../config/config-types.ts";
import type { CliOptions } from "../config/resolved-config.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { resolveWorkspacePackages } from "./validation.ts";
import { discoverWorkspaceRoot } from "./workspace-root.ts";

/** Outcome of {@link resolvePackages}. */
export type ResolvedPackages =
	| {
			/** `--affected-since` selected no package. */
			kind: "none-affected";
	  }
	| {
			/** Packages were selected. */
			kind: "selected";
			/** The selected packages. */
			packageInfos: Array<PackageInfo>;
			/** Absolute workspace root directory. */
			workspaceRoot: string;
	  }
	| {
			/** Resolution failed; the run exits `2` with `message`. */
			kind: "error";
			/** Message for stderr. */
			message: string;
	  };

interface EnumerationRoot {
	exclude?: Array<string> | undefined;
	patterns?: Array<string> | undefined;
	workspaceRoot: string;
}

/**
 * Resolve the workspace root and the packages a workspace run selects.
 * @param options - CLI options, dependencies and workspace config.
 * @param options.cli - Parsed command-line options.
 * @param options.dependencies - Child process runner and file system.
 * @param options.dependencies.childProcess - Runs the change detector.
 * @param options.dependencies.fileSystem - File system to enumerate.
 * @param options.workspace - The `workspace` config block, if any.
 * @returns The packages and root, `noAffected`, or an error.
 * @throws {Error} When the root or a named package cannot be found.
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
		return cli.affectedSince !== undefined
			? { kind: "none-affected" }
			: { kind: "error", message: emptyWorkspaceMessage(patterns) };
	}

	return { kind: "selected", packageInfos, workspaceRoot };
}

function resolveEnumerationRoot(
	fileSystem: FileSystem,
	workspace?: WorkspaceConfig,
): EnumerationRoot {
	if (workspace?.packages !== undefined) {
		// The config schema requires `root` with `packages`.
		assert(workspace.root !== undefined);
		return {
			exclude: workspace.exclude,
			patterns: workspace.packages,
			workspaceRoot: workspace.root,
		};
	}

	return {
		exclude: workspace?.exclude,
		workspaceRoot: discoverWorkspaceRoot(process.cwd(), fileSystem),
	};
}

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
