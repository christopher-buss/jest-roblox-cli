import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import { requireRojoProject } from "../config/rojo-project.ts";
import { collectRojoMounts } from "../shadow/root-reachability.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ChangeScope } from "./change-scope.ts";
import { resolveChangeScope } from "./change-scope.ts";
import type { PartialRun, PartialRunInput } from "./partial-run.ts";
import { resolvePartialRun } from "./partial-run.ts";

/** A Partial Run and the scope its files are classified in. */
export type RelatedRun = PartialRun & {
	/** Roots and triggers the files are classified against. */
	scope: ChangeScope;
};

/** Inputs of {@link resolveRelatedRun}. */
export interface RelatedRunInput extends Pick<PartialRunInput, "cli" | "seams" | "timing"> {
	/** File system the workspace markers are looked up on. */
	fileSystem: FileSystem;
	/** Reads the Rojo tree of the run; none on a typecheck-only run. */
	readRojoTree: () => RojoTreeNode | undefined;
	/** Root config of the run. */
	rootConfig: ResolvedConfig;
}

/**
 * Resolve the files of a Partial Run and the scope they are classified in.
 *
 * @param input - CLI options, Rojo tree, root config, file system, git runner
 *   and profiler.
 * @returns The Partial Run with its scope, or `undefined` on a full run.
 */
export function resolveRelatedRun({
	fileSystem,
	readRojoTree,
	rootConfig,
	...run
}: RelatedRunInput): RelatedRun | undefined {
	const partialRun = resolvePartialRun({ ...run, rootDirectory: rootConfig.rootDir });
	if (partialRun === undefined) {
		return undefined;
	}

	const rojoTree = readRojoTree();
	return {
		...partialRun,
		scope: resolveChangeScope({
			fileSystem,
			forceRerunTriggers: rootConfig.forceRerunTriggers,
			projectRoot: rootConfig.rootDir,
			rojoRoots:
				rojoTree === undefined
					? []
					: collectRojoMounts(
							rojoTree,
							path.dirname(
								path.resolve(rootConfig.rootDir, requireRojoProject(rootConfig)),
							),
						),
		}),
	};
}
