import { collectMounts } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { InstancePathResolver } from "../config/instance-path.ts";
import { createInstancePathResolver } from "../config/instance-path.ts";
import { loadConfig } from "../config/loader.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import { createFsClassifier } from "../config/projects.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { resolveAllTsconfigMappings } from "../executor/tsconfig-mappings.ts";
import { classifyTestFiles, discoverTestFiles } from "../run/discovery.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { loadPackageRojoTree } from "./package-rojo-tree.ts";

const ROJO_PROJECT_DEFAULT = "test.project.json";

export interface LoadedPackage {
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
}

export async function loadWorkspacePackagesAsync({
	cli,
	packageInfos,
	timing,
}: {
	cli: CliOptions;
	packageInfos: Array<PackageInfo>;
	timing: TimingCollector;
}): Promise<Array<LoadedPackage>> {
	const loaded: Array<LoadedPackage> = [];

	for (const info of packageInfos) {
		const fileConfig = await timing.profileAsync(`load-config:${info.name}`, async () => {
			return loadConfig(undefined, info.packageDirectory);
		});
		const packageConfig = narrowPackageTestPathPattern(
			mergeCliWithConfig(cli, fileConfig),
			cli,
			info,
		);

		loaded.push({
			descriptor: buildPackageDescriptor(info, packageConfig),
			info,
			pkgConfig: packageConfig,
		});
	}

	return loaded;
}

// A package's rojo project is resolved per-package only; the workspace-root
// config is intentionally not consulted (see `buildPackageDescriptor`).
function resolveRojoProjectPath(info: PackageInfo, packageConfig: ResolvedConfig): string {
	return path.resolve(info.packageDirectory, packageConfig.rojoProject ?? ROJO_PROJECT_DEFAULT);
}

// The package's own Rojo tree is the authority on where its sources land, so
// each package narrows against its own mounts. Built here rather than reused
// from `resolvePackageContextsAsync` because the narrow runs before contexts
// resolve — and only for a package carrying a pattern, so a bare workspace run
// never loads a tree for it.
function packageInstancePathResolver(
	info: PackageInfo,
	packageConfig: ResolvedConfig,
): InstancePathResolver {
	const rojoTree = loadPackageRojoTree(
		resolveRojoProjectPath(info, packageConfig),
		info.packageDirectory,
	);
	// The two bases differ whenever a package points `rootDir` at a
	// subdirectory: discovery relativizes files against `rootDir`, while
	// `loadPackageRojoTree` rebases mounts onto the package directory and the
	// tsconfigs are read from there too.
	return createInstancePathResolver({
		mountBase: info.packageDirectory,
		mounts: collectMounts(rojoTree, "", createFsClassifier(info.packageDirectory)),
		rootDirectory: packageConfig.rootDir,
		tsconfigMappings: resolveAllTsconfigMappings(info.packageDirectory),
	});
}

/**
 * Resolve a `--testPathPattern` against this package's files Node-side, then
 * forward an Instance-namespace pattern (see {@link narrowForLuauRun}).
 *
 * A pattern that matches no file in this package simply targets a different
 * package: keep the (zero-matching) raw pattern so Jest-on-Roblox runs
 * nothing, and set `passWithNoTests` so it doesn't `exit(1)`. The raw pattern
 * is load-bearing here — clearing it would drop the filter entirely and make
 * the Luau side fall back to `testMatch`, running the whole package.
 */
function narrowPackageTestPathPattern(
	packageConfig: ResolvedConfig,
	cli: CliOptions,
	info: PackageInfo,
): ResolvedConfig {
	if (packageConfig.testPathPattern === undefined) {
		return packageConfig;
	}

	const { files } = discoverTestFiles(packageConfig);
	// `mergeCliWithConfig` no longer folds the typecheck flags into the resolved
	// config, so resolve the CLI layer here to keep `--typecheckOnly` honored
	// when classifying runtime files for the narrow.
	const typecheck = resolveTypecheckConfig({
		cli: { enabled: cli.typecheck, only: cli.typecheckOnly, tsconfig: cli.typecheckTsconfig },
		root: packageConfig.typecheck,
	});
	const { runtimeFiles } = classifyTestFiles(files, typecheck);
	if (runtimeFiles.length === 0) {
		return { ...packageConfig, passWithNoTests: true };
	}

	return narrowForLuauRun({
		config: packageConfig,
		filterActive: true,
		runtimeFiles,
		toInstancePath: packageInstancePathResolver(info, packageConfig),
	});
}

function buildPackageDescriptor(
	info: PackageInfo,
	packageConfig: ResolvedConfig,
): PackageDescriptor {
	// Propagate per-pkg coverage knobs to the descriptor so
	// `prepareWorkspaceCoverage` sees the merged values, not just the
	// workspace-root config. Per-pkg overrides workspace-root: previously
	// the workspace-prepare matcher was reading from the root config and
	// silently dropping per-pkg patterns set via `jest.shared.ts` extends.
	//
	// `coveragePathIgnorePatterns` always resolves post-merge — both pkg
	// and root carry the `DEFAULT_CONFIG` 6-pattern array when nothing
	// explicit is set. Passing it unconditionally would make every
	// descriptor "override" the root, dropping a workspace-root custom
	// value for packages that wanted to inherit it. `resolveConfig`
	// (loader.ts:42) builds via `Object.assign({}, DEFAULT_CONFIG, ...)`
	// — when the package's `test` block omits the key, the field keeps
	// the `DEFAULT_CONFIG` reference verbatim. Reference identity is the
	// "user explicitly set this" signal; treat ref-equal as "inherit
	// root" by leaving the descriptor field undefined.
	const hasExplicitIgnore =
		packageConfig.coveragePathIgnorePatterns !== DEFAULT_CONFIG.coveragePathIgnorePatterns;
	// Per-pkg `coverageCache` opt-out drives the workspace cache gate.
	// Pass it through only when the pkg's value diverges from the
	// default; an undefined descriptor field means "inherit
	// DEFAULT_CONFIG" inside `prepareWorkspaceCoverage`.
	const hasExplicitCoverageCache = packageConfig.coverageCache !== DEFAULT_CONFIG.coverageCache;

	const descriptor: PackageDescriptor = {
		name: info.name,
		luauRoots: packageConfig.luauRoots,
		packageDirectory: info.packageDirectory,
		rojoProjectPath: resolveRojoProjectPath(info, packageConfig),
	};
	if (hasExplicitCoverageCache) {
		descriptor.coverageCache = packageConfig.coverageCache;
	}

	if (hasExplicitIgnore) {
		descriptor.coveragePathIgnorePatterns = packageConfig.coveragePathIgnorePatterns;
	}

	// No DEFAULT_CONFIG entry to compare against — `collectCoverageFrom` is
	// absent unless the user set it, so the merged value is already the
	// package's own answer.
	if (packageConfig.collectCoverageFrom !== undefined) {
		descriptor.collectCoverageFrom = packageConfig.collectCoverageFrom;
	}

	return descriptor;
}
