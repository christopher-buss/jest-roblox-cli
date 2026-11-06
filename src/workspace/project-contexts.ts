import { collectPaths } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { createFsClassifier } from "../config/project-mounts.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { assertKnownProjectNames, resolveAllProjects } from "../config/projects.ts";
import type {
	InlineProjectConfig,
	ProjectEntry,
	ProjectTestConfig,
	ResolvedConfig,
} from "../config/schema.ts";
import {
	applySetupResolver,
	createRojoResolverCache,
	createSetupResolver,
	type RojoResolverCache,
} from "../config/setup-resolver.ts";
import type { TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader } from "../executor/tsconfig-mappings.ts";
import type { PackageDescriptor } from "../staging/synthesizer-types.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { RojoResolverFactory } from "../utils/rojo-project-reader.ts";
import { nodeRojoResolverFactory } from "../utils/rojo-project-reader.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { loadPackageRojoTree } from "./package-rojo-tree.ts";

/** A loaded package with its cache root and resolved projects. */
export interface PackageContext {
	/** Directory under the run cache that holds the package's stubs. */
	cacheRoot: string;
	/** Descriptor the synthesizer mounts the package from. */
	descriptor: PackageDescriptor;
	/** Package name and directory. */
	info: PackageInfo;
	/** Package config merged with the CLI options. */
	pkgConfig: ResolvedConfig;
	/** Projects the package runs. */
	projects: Array<ResolvedProjectConfig>;
}

interface PackageReaders {
	childProcess: ChildProcessRunner;
	createResolver: RojoResolverFactory;
	fileSystem: FileSystem;
	rojoCache: RojoResolverCache;
	tsconfigReader: TsconfigReader;
}

/**
 * One package's inputs to project synthesis, in the frame its mounts are in.
 */
interface VirtualProjectInput {
	fileSystem: FileSystem;
	packageConfig: ResolvedConfig;
	packageDirectory: string;
	packageName: string;
	rojoTree: RojoTreeNode;
}

/**
 * Narrow the resolved contexts to the `--project` names the caller asked for,
 * dropping packages left with no project. An unknown name is a hard error
 * listing what is available.
 * @param contexts - Resolved package contexts.
 * @param filter - Project names to keep, or `undefined` to keep all.
 * @returns The contexts that keep at least one project.
 * @throws {Error} When a name matches no project.
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

	assertKnownProjectNames(filter, available);

	return contexts
		.map((ctx) => {
			return {
				...ctx,
				projects: ctx.projects.filter((project) => wanted.has(project.displayName)),
			};
		})
		.filter((ctx) => ctx.projects.length > 0);
}

/**
 * Resolve each loaded package's projects and setup files.
 * @param options - Cache directory, loaded packages and reader seams.
 * @param options.cacheDirectory - Run cache directory.
 * @param options.childProcess - Runs lute for a Luau Config that holds code.
 * @param options.createResolver - Rojo resolver factory.
 * @param options.fileSystem - File system to read through.
 * @param options.loaded - Loaded packages.
 * @param options.tsconfigReader - Reads each project's tsconfig.
 * @returns One context per loaded package, in order.
 * @rejects When a package's projects fail to resolve.
 */
export async function resolvePackageContextsAsync({
	cacheDirectory,
	childProcess,
	createResolver = nodeRojoResolverFactory,
	fileSystem = nodeFileSystem,
	loaded,
	tsconfigReader = nodeTsconfigReader,
}: {
	/** Run cache directory; each package gets a directory below it. */
	cacheDirectory: string;
	/** How a Luau Config that holds code runs lute. */
	childProcess: ChildProcessRunner;
	/** Rojo resolver factory. Defaults to the real one. */
	createResolver?: RojoResolverFactory;
	/**
	 * Where each package's rojo project is read from. Defaults to the real
	 * one.
	 */
	fileSystem?: FileSystem;
	/** Loaded packages to resolve. */
	loaded: Array<LoadedPackage>;
	/** Tsconfig reader. Defaults to the real one. */
	tsconfigReader?: TsconfigReader;
}): Promise<Array<PackageContext>> {
	const contexts: Array<PackageContext> = [];
	// Packages commonly mount the same rojo project (a shared test project at
	// the workspace root, or one package extending another's). Sharing the
	// cache across the loop walks each distinct project file once.
	const rojoCache = createRojoResolverCache();
	const readers: PackageReaders = {
		childProcess,
		createResolver,
		fileSystem,
		rojoCache,
		tsconfigReader,
	};

	for (const entry of loaded) {
		const projects = await resolvePackageProjectsAsync(entry, readers);
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

function synthesizeVirtualProjectEntry({
	fileSystem,
	packageConfig,
	packageDirectory,
	packageName,
	rojoTree,
}: VirtualProjectInput): InlineProjectConfig {
	const mountPaths: Array<string> = [];
	collectPaths(rojoTree, mountPaths);

	// Use the FS classifier so dotted-name directories (e.g. `src/has.dot`)
	// are not mis-classified as files. `path.posix.extname` would treat
	// `.dot` as an extension and skip the directory entirely.
	const classify = createFsClassifier(packageDirectory, fileSystem);
	const directoryRoots = mountPaths.filter((value) => classify(value) === "directory");

	const include = directoryRoots.flatMap((root) => {
		return packageConfig.testMatch.map((pattern) => path.posix.join(root, pattern));
	});

	// Carry the package's global `test.exclude` onto the virtual project so
	// `discoverProjectTestFiles` subtracts it — the workspace analogue of
	// single-mode `test.exclude`. Explicit `projects:` carry their own
	// per-project `exclude` instead and never reach this synthesis.
	let test: ProjectTestConfig = { displayName: packageName, include };
	if (packageConfig.exclude !== undefined) {
		test = { ...test, exclude: packageConfig.exclude };
	}

	return { test };
}

function resolveProjectEntries(input: VirtualProjectInput): Array<ProjectEntry> {
	const rawProjects = input.packageConfig.projects;
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return rawProjects;
	}

	return [synthesizeVirtualProjectEntry(input)];
}

/**
 * Resolve setupFiles / setupFilesAfterEnv for every project against the
 * package's own rojo tree. Without this, the materializer payload carries raw
 * filesystem paths that Jest cannot find as ModuleScript Instances.
 *
 * `createSetupResolver` eagerly builds a `RojoResolver` (a full project-tree
 * filesystem walk) — by far the dominant resolveContexts cost. Skip it entirely
 * when no project declares setup files, mirroring the guard in
 * `resolveSetupFilePaths` (run/discovery.ts). Packages with no setup files (the
 * common case) then pay nothing here.
 * @param options - Package, projects and reader seams.
 * @param options.entry - Loaded package whose Rojo tree to resolve against.
 * @param options.projects - Projects whose setup files to resolve.
 */
function resolvePackageSetupFiles({
	createResolver,
	entry,
	projects,
	rojoCache,
}: PackageReaders & {
	readonly entry: LoadedPackage;
	readonly projects: Array<ResolvedProjectConfig>;
}): void {
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
		cache: rojoCache,
		configDirectory: entry.info.packageDirectory,
		createResolver,
		rojoConfigPath: entry.descriptor.rojoProjectPath,
	});
	for (const project of projects) {
		applySetupResolver(project.config, resolveSetup);
	}
}

async function resolvePackageProjectsAsync(
	entry: LoadedPackage,
	readers: PackageReaders,
): Promise<Array<ResolvedProjectConfig>> {
	const { childProcess, fileSystem, tsconfigReader } = readers;
	const { descriptor, info, pkgConfig } = entry;
	const rojoTree = loadPackageRojoTree({
		fileSystem,
		packageDirectory: descriptor.packageDirectory,
		rojoProjectPath: descriptor.rojoProjectPath,
	});
	const projectEntries = resolveProjectEntries({
		fileSystem,
		packageConfig: pkgConfig,
		packageDirectory: info.packageDirectory,
		packageName: info.name,
		rojoTree,
	});
	const projects = await resolveAllProjects({
		childProcess,
		cwd: info.packageDirectory,
		entries: projectEntries,
		fileSystem,
		rojoTree,
		rootConfig: pkgConfig,
		tsconfigReader,
	});

	resolvePackageSetupFiles({ ...readers, entry, projects });
	return projects;
}
