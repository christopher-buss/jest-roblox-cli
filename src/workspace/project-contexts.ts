import * as path from "node:path";

import { buildImplicitProject } from "../config/implicit-project.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { resolveAllProjects } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { resolveAllSetupFilePaths, type SetupResolverFactory } from "../config/setup-resolver.ts";
import type { WorkspacePackageDescriptor } from "../shadow/workspace-prepare-types.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { LoadedPackage } from "./package-loader.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { loadPackageRojoTree } from "./package-rojo-tree.ts";

/** A loaded package with its cache root and resolved projects. */
export interface PackageContext {
	/** Directory under the run cache that holds the package's stubs. */
	cacheRoot: string;
	/** Descriptor the synthesizer mounts the package from. */
	descriptor: WorkspacePackageDescriptor;
	/** Package name and directory. */
	info: PackageInfo;
	/** Package config merged with the CLI options. */
	pkgConfig: ResolvedConfig;
	/** Projects the package runs. */
	projects: Array<ResolvedProjectConfig>;
}

interface PackageReaders {
	childProcess: ChildProcessRunner;
	createSetupResolver: SetupResolverFactory;
	fileSystem: FileSystem;
	tsconfigReader: TsconfigReader;
}

/**
 * Resolve each loaded package's projects and setup files.
 * @param options - Cache directory, loaded packages and reader seams.
 * @param options.cacheDirectory - Run cache directory.
 * @param options.childProcess - Runs lute for a Luau Config that holds code.
 * @param options.createSetupResolver - Builds the setup-file resolver.
 * @param options.fileSystem - File system to read through.
 * @param options.loaded - Loaded packages.
 * @param options.tsconfigReader - Reads each project's tsconfig.
 * @returns One context per loaded package, in order.
 * @rejects When a package's projects fail to resolve.
 */
export async function resolvePackageContextsAsync({
	cacheDirectory,
	childProcess,
	createSetupResolver,
	fileSystem,
	loaded,
	tsconfigReader,
}: {
	/** Run cache directory; each package gets a directory below it. */
	cacheDirectory: string;
	/** How a Luau Config that holds code runs lute. */
	childProcess: ChildProcessRunner;
	/** Rojo resolver factory. */
	createSetupResolver: SetupResolverFactory;
	/** Where each package's rojo project is read from. */
	fileSystem: FileSystem;
	/** Loaded packages to resolve. */
	loaded: Array<LoadedPackage>;
	/** Tsconfig reader. */
	tsconfigReader: TsconfigReader;
}): Promise<Array<PackageContext>> {
	const contexts: Array<PackageContext> = [];
	const readers: PackageReaders = {
		childProcess,
		createSetupResolver,
		fileSystem,
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

async function resolveConfiguredProjectsAsync(
	{ descriptor, info, pkgConfig }: LoadedPackage,
	{ childProcess, fileSystem, tsconfigReader }: PackageReaders,
): Promise<Array<ResolvedProjectConfig>> {
	const rojoTree = loadPackageRojoTree({ fileSystem, ...descriptor });
	return pkgConfig.projects === undefined || pkgConfig.projects.length === 0
		? [
				buildImplicitProject({
					config: { ...pkgConfig, rojoProject: descriptor.rojoProjectPath },
					fileSystem,
					rojoTree,
					tsconfigReader,
				}),
			]
		: resolveAllProjects({
				childProcess,
				cwd: info.packageDirectory,
				entries: pkgConfig.projects,
				fileSystem,
				rojoTree,
				rootConfig: pkgConfig,
				tsconfigReader,
			});
}

async function resolvePackageProjectsAsync(
	{ descriptor, info, pkgConfig }: LoadedPackage,
	readers: PackageReaders,
): Promise<Array<ResolvedProjectConfig>> {
	const projects = await resolveConfiguredProjectsAsync({ descriptor, info, pkgConfig }, readers);

	const source = {
		configDirectory: info.packageDirectory,
		rojoConfigPath: descriptor.rojoProjectPath,
	};
	resolveAllSetupFilePaths({
		configs: projects.map((project) => project.config),
		createSetupResolver: readers.createSetupResolver,
		sourceOf: () => source,
	});
	return projects;
}
