import { collectPaths, loadRojoProject, rebaseTreePaths } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import { createFsClassifier, resolveAllProjects } from "../config/projects.ts";
import type { InlineProjectConfig, ProjectEntry, ResolvedConfig } from "../config/schema.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageInfo } from "./package-resolver.ts";

export interface PackageContext {
	cacheRoot: string;
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
	projects: Array<ResolvedProjectConfig>;
}

/**
 * Narrow the resolved contexts to the `--project` names the caller asked for,
 * dropping packages left with no project. An unknown name is a hard error
 * listing what is available.
 */
export function applyProjectFilter(
	contexts: Array<PackageContext>,
	filter: Array<string> | undefined,
): Array<PackageContext> {
	if (filter === undefined || filter.length === 0) {
		return contexts;
	}

	const wanted = new Set(filter);
	const available = new Set<string>();
	for (const ctx of contexts) {
		for (const project of ctx.projects) {
			available.add(project.displayName);
		}
	}

	const unknown = filter.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}

	return contexts
		.map((ctx) => {
			return {
				...ctx,
				projects: ctx.projects.filter((project) => wanted.has(project.displayName)),
			};
		})
		.filter((ctx) => ctx.projects.length > 0);
}

export async function resolvePackageContextsAsync({
	cacheDirectory,
	loaded,
}: {
	cacheDirectory: string;
	loaded: Array<LoadedPackage>;
}): Promise<Array<PackageContext>> {
	const contexts: Array<PackageContext> = [];

	for (const entry of loaded) {
		const projects = await resolvePackageProjectsAsync(entry);
		contexts.push({
			cacheRoot: path.join(cacheDirectory, entry.info.name),
			descriptor: entry.descriptor,
			info: entry.info,
			pkgConfig: entry.pkgConfig,
			projects,
		});
	}

	return contexts;
}

function synthesizeVirtualProjectEntry(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): InlineProjectConfig {
	const mountPaths: Array<string> = [];
	collectPaths(rojoTree, mountPaths);

	// Use the FS classifier so dotted-name directories (e.g. `src/has.dot`)
	// are not mis-classified as files. `path.posix.extname` would treat
	// `.dot` as an extension and skip the directory entirely.
	const classify = createFsClassifier(packageDirectory);
	const directoryRoots = mountPaths.filter((value) => classify(value) === "directory");

	const include = directoryRoots.flatMap((root) => {
		return packageConfig.testMatch.map((pattern) => path.posix.join(root, pattern));
	});

	// Carry the package's global `test.exclude` onto the virtual project so
	// `discoverProjectTestFiles` subtracts it — the workspace analogue of
	// single-mode `test.exclude`. Explicit `projects:` carry their own
	// per-project `exclude` instead and never reach this synthesis.
	return {
		test: {
			displayName: packageName,
			...(packageConfig.exclude !== undefined ? { exclude: packageConfig.exclude } : {}),
			include,
		},
	};
}

// `ResolvedConfig.projects` is structurally typed `Array<string>`
// post-resolution, but workspace mode reads the field BEFORE per-package
// resolution runs, when entries are still raw `ProjectEntry` (string paths or
// `{ test }` inline configs). The crossing is bounded by this guard and by
// consumers that fail on malformed entries.
function isProjectEntryArray(value: unknown): value is Array<ProjectEntry> {
	return Array.isArray(value);
}

function readRawProjects(config: ResolvedConfig): Array<ProjectEntry> | undefined {
	const projects: unknown = config.projects;
	if (!isProjectEntryArray(projects)) {
		return undefined;
	}

	return projects;
}

function resolveProjectEntries(
	packageName: string,
	packageConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	packageDirectory: string,
): Array<ProjectEntry> {
	const rawProjects = readRawProjects(packageConfig);
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return rawProjects;
	}

	return [synthesizeVirtualProjectEntry(packageName, packageConfig, rojoTree, packageDirectory)];
}

function loadPackageRojoTree(rojoProjectPath: string, packageDirectory: string): RojoTreeNode {
	// `loadRojoProject` resolves nested projects and expresses every `$path`
	// relative to the project file's directory. Include roots, however, resolve
	// relative to the package directory. When the project file lives in a
	// subdirectory (e.g. `test/default.project.json`) the two bases diverge, so
	// rebase the tree to package-relative paths so mount resolution
	// (findInTree / collectMounts) compares like-for-like.
	const rojoDirectory = path.dirname(rojoProjectPath);
	const project = loadRojoProject(rojoProjectPath);
	return rebaseTreePaths(project.tree, rojoDirectory, packageDirectory);
}

function applySetupResolver(
	config: Pick<ResolvedConfig, "setupFiles" | "setupFilesAfterEnv">,
	resolve: (input: string) => string,
): void {
	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}

// Resolve setupFiles / setupFilesAfterEnv for every project against the
// package's own rojo tree. Without this, the materializer payload carries raw
// filesystem paths that Jest cannot find as ModuleScript Instances.
//
// `createSetupResolver` eagerly builds a `RojoResolver` (a full project-tree
// filesystem walk) — by far the dominant resolveContexts cost. Skip it entirely
// when no project declares setup files, mirroring the guard in
// `resolveSetupFilePaths` (run/discovery.ts). Packages with no setup files (the
// common case) then pay nothing here.
function resolvePackageSetupFiles(
	projects: Array<ResolvedProjectConfig>,
	entry: LoadedPackage,
): void {
	const hasSetupFiles = projects.some((project) => {
		return (
			project.config.setupFiles !== undefined ||
			project.config.setupFilesAfterEnv !== undefined
		);
	});
	if (!hasSetupFiles) {
		return;
	}

	const resolveSetup = createSetupResolver({
		configDirectory: entry.info.packageDirectory,
		rojoConfigPath: entry.descriptor.rojoProjectPath,
	});
	for (const project of projects) {
		applySetupResolver(project.config, resolveSetup);
	}
}

async function resolvePackageProjectsAsync(
	entry: LoadedPackage,
): Promise<Array<ResolvedProjectConfig>> {
	const { descriptor, info, pkgConfig } = entry;
	const rojoTree = loadPackageRojoTree(descriptor.rojoProjectPath, descriptor.packageDirectory);
	const projectEntries = resolveProjectEntries(
		info.name,
		pkgConfig,
		rojoTree,
		info.packageDirectory,
	);
	const projects = await resolveAllProjects(
		projectEntries,
		pkgConfig,
		rojoTree,
		info.packageDirectory,
	);

	resolvePackageSetupFiles(projects, entry);
	return projects;
}
