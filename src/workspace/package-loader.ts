import * as path from "node:path";

import { loadConfig } from "../config/loader.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { PackageInfo } from "./package-resolver.ts";

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
		// The `--testPathPattern` narrow happens per project in
		// `selectWorkspaceTests`, where the project's resolved Rojo mounts are
		// in hand; the package config carries the raw FS pattern until then.
		const packageConfig = mergeCliWithConfig(cli, fileConfig);

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
		// The same field the report anchors this package's coverage globs on
		// (`readCoverageSettings`), so a file earns probes exactly when the
		// report asks about it.
		rootDir: packageConfig.rootDir,
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
