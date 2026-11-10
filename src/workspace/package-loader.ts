import type { PackageConfig, PackageConfigLoader } from "../config/loader.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import type { CliOptions, ResolvedConfig } from "../config/resolved-config.ts";
import { requireRojoProject, resolveRojoProject } from "../config/rojo-project.ts";
import type { WorkspacePackageDescriptor } from "../shadow/workspace-prepare-types.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PackageInfo } from "./package-resolver.ts";

const ROJO_PROJECT_DEFAULT = "test.project.json";

/** A package with its merged config and synthesizer descriptor. */
export interface LoadedPackage {
	/** Descriptor the synthesizer mounts the package from. */
	descriptor: WorkspacePackageDescriptor;
	/** Package name and directory. */
	info: PackageInfo;
	/** Package config merged with the CLI options. */
	pkgConfig: ResolvedConfig;
}

/** A package and its config, loaded once for the whole run. */
export interface WorkspacePackage {
	/** The package config, as declared and as resolved. */
	config: PackageConfig;
	/** Package name and directory. */
	info: PackageInfo;
}

/** Packages to load and the seams to load them through. */
export interface LoadPackageConfigsOptions {
	/** How a Luau Config that holds code runs lute. */
	childProcess: ChildProcessRunner;
	/** Where each package's config is read from. */
	fileSystem: FileSystem;
	/** Config loader. */
	loadPackageConfig: PackageConfigLoader;
	/** Packages to load. */
	packageInfos: Array<PackageInfo>;
	/** Collector for the per-package config load spans. */
	timing: TimingCollector;
}

/**
 * Load each package's config once, for the consensus and for the run.
 * @param options - Packages, loader and timing.
 * @returns One package per input, in order.
 * @rejects When a package config fails to load.
 */
export async function loadPackageConfigsAsync({
	childProcess,
	fileSystem,
	loadPackageConfig,
	packageInfos,
	timing,
}: LoadPackageConfigsOptions): Promise<Array<WorkspacePackage>> {
	return timing.profileAsync("loadPackages", async () => {
		const packages: Array<WorkspacePackage> = [];
		for (const info of packageInfos) {
			const config = await timing.profileAsync(`load-config:${info.name}`, async () => {
				return loadPackageConfig({ childProcess, cwd: info.packageDirectory, fileSystem });
			});
			packages.push({ config, info });
		}

		return packages;
	});
}

/**
 * Merge each package config with the CLI options and describe its mount.
 * @param options - CLI options that override each package config, the file
 *   system, and the loaded packages.
 * @returns One loaded package per input, in order.
 */
export function loadWorkspacePackages({
	cli,
	fileSystem,
	packages,
}: {
	cli: CliOptions;
	fileSystem: FileSystem;
	packages: Array<WorkspacePackage>;
}): Array<LoadedPackage> {
	return packages.map(({ config, info }) => {
		const merged = mergeCliWithConfig(cli, config.resolved);
		const packageConfig = {
			...merged,
			rojoProject: resolveRojoProject({
				config: { rojoProject: merged.rojoProject, rootDir: info.packageDirectory },
				defaultFile: ROJO_PROJECT_DEFAULT,
				fileSystem,
			}),
		};
		return {
			descriptor: buildPackageDescriptor(info, packageConfig),
			info,
			pkgConfig: packageConfig,
		};
	});
}

function buildPackageDescriptor(
	info: PackageInfo,
	packageConfig: ResolvedConfig,
): WorkspacePackageDescriptor {
	return {
		name: info.name,
		luauRoots: packageConfig.luauRoots,
		packageDirectory: info.packageDirectory,
		rojoProjectPath: requireRojoProject(packageConfig),
	};
}
