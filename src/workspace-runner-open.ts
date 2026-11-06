import * as path from "node:path";
import process from "node:process";

import type { TimingCollector } from "./timing/orchestration-collector.ts";
import type { FileSystem } from "./utils/file-system.ts";
import type { OpenedWorkspace, ResolvedRunWorkspaceOptions } from "./workspace-runner-types.ts";
import { ensurePackageDirectories } from "./workspace/ensure-paths.ts";
import { type LoadedPackage, loadWorkspacePackagesAsync } from "./workspace/package-loader.ts";
import { type PreflightError, validatePackages } from "./workspace/preflight.ts";
import { resolvePackageContextsAsync } from "./workspace/project-contexts.ts";
import { selectWorkspaceTests, type WorkspaceTestSelection } from "./workspace/test-selection.ts";

const WORKSPACE_CACHE_DIRECTORY = path.join(".jest-roblox", "workspace");

/** Inputs to open a workspace run. */
export interface OpenWorkspaceRunOptions extends Pick<
	ResolvedRunWorkspaceOptions,
	| "childProcess"
	| "cli"
	| "createResolver"
	| "cwd"
	| "fileSystem"
	| "loadPackageConfig"
	| "packageInfos"
	| "tsconfigReader"
	| "workspaceRoot"
> {
	/** Span-tree profiler for the run. */
	timing: TimingCollector;
}

/** An opened workspace with its selected tests. */
export interface OpenedWorkspaceRun extends OpenedWorkspace {
	/** Tests selected for the run. */
	selection: WorkspaceTestSelection;
}

/**
 * Every package loaded, validated, and resolved to the tests it owns — or
 * `undefined` when preflight or test selection rejected the run.
 *
 * @param options - Run inputs.
 * @returns The opened run, or `undefined` when rejected.
 */
export async function openWorkspaceRunAsync(
	options: OpenWorkspaceRunOptions,
): Promise<OpenedWorkspaceRun | undefined> {
	const opened = await openWorkspaceAsync(options);
	if (opened === undefined) {
		return undefined;
	}

	const selection = await selectTestsAsync({ ...opened, options });
	if (selection.emptyPackageErrors.length > 0) {
		reportTestSelectionErrors(selection);
		return undefined;
	}

	return { ...opened, selection };
}

function writePreflightErrors(errors: Array<PreflightError>): void {
	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}
}

function runWorkspacePreflight(loaded: Array<LoadedPackage>, fileSystem: FileSystem): boolean {
	const descriptors = loaded.map((entry) => entry.descriptor);
	ensurePackageDirectories(descriptors, fileSystem);

	const errors = validatePackages(descriptors, fileSystem);
	if (errors.length === 0) {
		return true;
	}

	writePreflightErrors(errors);
	return false;
}

function createWorkspaceCacheDirectory(fileSystem: FileSystem, workspaceRoot: string): string {
	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fileSystem.mkdirSync(cacheDirectory, { recursive: true });
	return cacheDirectory;
}

/**
 * Every package loaded, validated, and given somewhere to cache — or
 * `undefined` when preflight rejected one, which ends the run.
 *
 * @param options - Run inputs.
 * @returns The opened workspace, or `undefined` when preflight failed.
 */
async function openWorkspaceAsync({
	childProcess,
	cli,
	fileSystem,
	loadPackageConfig,
	packageInfos,
	timing,
	workspaceRoot,
}: OpenWorkspaceRunOptions): Promise<OpenedWorkspace | undefined> {
	// Load each package's config FIRST so that per-package `rojoProject`
	// declarations override the workspace default. Building the descriptor
	// (and the path preflight uses) before loadConfig pinned every package
	// to the parent's rojo file.
	const loaded = await timing.profileAsync("loadPackages", async () => {
		return loadWorkspacePackagesAsync({
			childProcess,
			cli,
			fileSystem,
			loadPackageConfig,
			packageInfos,
			timing,
		});
	});

	if (!runWorkspacePreflight(loaded, fileSystem)) {
		return undefined;
	}

	return { cacheDirectory: createWorkspaceCacheDirectory(fileSystem, workspaceRoot), loaded };
}

function reportTestSelectionErrors(selection: WorkspaceTestSelection): void {
	for (const error of selection.emptyPackageErrors) {
		process.stderr.write(`${error}\n`);
	}
}

/**
 * Resolve each package to its projects, then to the tests those projects own.
 *
 * @param options - The opened workspace and the run inputs.
 * @returns The workspace test selection.
 */
async function selectTestsAsync({
	cacheDirectory,
	loaded,
	options,
}: OpenedWorkspace & { options: OpenWorkspaceRunOptions }): Promise<WorkspaceTestSelection> {
	const { childProcess, cli, createResolver, fileSystem, timing, tsconfigReader } = options;
	const contexts = await timing.profileAsync("resolveContexts", async () => {
		return resolvePackageContextsAsync({
			cacheDirectory,
			childProcess,
			createResolver,
			fileSystem,
			loaded,
			tsconfigReader,
		});
	});

	return timing.profile("discoverTests", () => {
		return selectWorkspaceTests({
			cli,
			contexts,
			cwd: options.cwd ?? process.cwd(),
			fileSystem,
		});
	});
}
