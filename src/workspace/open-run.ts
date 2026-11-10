import * as path from "node:path";

import { resolvePartialRun } from "../related/partial-run.ts";
import { runPreflight } from "../staging/preflight.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { WORK_DIRECTORY } from "../utils/work-directory.ts";
import { loadWorkspacePackages } from "./package-loader.ts";
import { resolvePackageContextsAsync } from "./project-contexts.ts";
import type { OpenedWorkspace, RunWorkspaceOptions } from "./run-stage-types.ts";
import { selectWorkspaceTests, type WorkspaceTestSelection } from "./test-selection.ts";

const WORKSPACE_CACHE_DIRECTORY = path.join(WORK_DIRECTORY, "workspace");

/** Inputs to open a workspace run. */
export type OpenWorkspaceRunOptions = Pick<
	RunWorkspaceOptions,
	| "childProcess"
	| "cli"
	| "createSetupResolver"
	| "cwd"
	| "fileSystem"
	| "packages"
	| "timing"
	| "tsconfigReader"
	| "workspaceRoot"
>;

/** An opened workspace with its selected tests. */
export interface OpenedWorkspaceRun extends OpenedWorkspace {
	/** Tests selected for the run. */
	selection: WorkspaceTestSelection;
}

/**
 * Load, validate and select tests for every package.
 * @param options - Run inputs.
 * @returns The opened run, or `undefined` when preflight failed.
 */
export async function openWorkspaceRunAsync(
	options: OpenWorkspaceRunOptions,
): Promise<OpenedWorkspaceRun | undefined> {
	const opened = openWorkspace(options);
	if (opened === undefined) {
		return undefined;
	}

	return { ...opened, selection: await selectTestsAsync({ ...opened, options }) };
}

function createWorkspaceCacheDirectory(fileSystem: FileSystem, workspaceRoot: string): string {
	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fileSystem.mkdirSync(cacheDirectory, { recursive: true });
	return cacheDirectory;
}

function openWorkspace({
	cli,
	fileSystem,
	packages,
	workspaceRoot,
}: OpenWorkspaceRunOptions): OpenedWorkspace | undefined {
	const loaded = loadWorkspacePackages({ cli, fileSystem, packages });

	if (
		!runPreflight(
			loaded.map((entry) => entry.descriptor),
			fileSystem,
		)
	) {
		return undefined;
	}

	return { cacheDirectory: createWorkspaceCacheDirectory(fileSystem, workspaceRoot), loaded };
}

async function selectTestsAsync({
	cacheDirectory,
	loaded,
	options,
}: OpenedWorkspace & { options: OpenWorkspaceRunOptions }): Promise<WorkspaceTestSelection> {
	const { childProcess, cli, createSetupResolver, fileSystem, timing, tsconfigReader } = options;
	const contexts = await timing.profileAsync("resolveContexts", async () => {
		return resolvePackageContextsAsync({
			cacheDirectory,
			childProcess,
			createSetupResolver,
			fileSystem,
			loaded,
			tsconfigReader,
		});
	});

	return timing.profile("discoverTests", () => {
		return selectWorkspaceTests({
			cli,
			contexts,
			cwd: options.cwd,
			fileSystem,
			partialRun: resolvePartialRun({
				...options,
				rootDirectory: options.workspaceRoot,
				seams: { childProcess },
			}),
			runnerTiming: timing.enabled,
			timing,
			tsconfigReader,
			workspaceRoot: options.workspaceRoot,
		});
	});
}
