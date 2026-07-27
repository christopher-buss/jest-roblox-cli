import * as path from "node:path";

import { loadConfig } from "../config/loader.ts";
import { mergeCliWithConfig } from "../config/merge.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { CliOptions, ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { classifyTestFiles, discoverTestFiles } from "../run/discovery.ts";
import type { PackageDescriptor } from "../staging/synthesizer.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { PackageInfo } from "./package-resolver.ts";

const ROJO_PROJECT_DEFAULT = "test.project.json";

export interface LoadedPackage {
	descriptor: PackageDescriptor;
	info: PackageInfo;
	pkgConfig: ResolvedConfig;
}

export async function loadWorkspacePackages({
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
		);

		loaded.push({
			descriptor: buildPackageDescriptor(info, packageConfig),
			info,
			pkgConfig: packageConfig,
		});
	}

	return loaded;
}

/**
 * Resolve a `--testPathPattern` against this package's files Node-side, then
 * forward an Instance-namespace basename pattern (see {@link
 * narrowForLuauRun}).
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

	return narrowForLuauRun(packageConfig, runtimeFiles, true);
}

function buildPackageDescriptor(
	info: PackageInfo,
	packageConfig: ResolvedConfig,
): PackageDescriptor {
	// `rojoProject` is resolved per-package only — the workspace-root
	// config is intentionally not consulted. A `pkg ?? config ?? DEFAULT`
	// chain would let a workspace-root value silently override the
	// per-package default for packages that omitted the field.
	const rojoProject = packageConfig.rojoProject ?? ROJO_PROJECT_DEFAULT;

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

	return {
		...(hasExplicitCoverageCache ? { coverageCache: packageConfig.coverageCache } : {}),
		...(hasExplicitIgnore
			? { coveragePathIgnorePatterns: packageConfig.coveragePathIgnorePatterns }
			: {}),
		...(packageConfig.luauRoots !== undefined ? { luauRoots: packageConfig.luauRoots } : {}),
		name: info.name,
		packageDirectory: info.packageDirectory,
		rojoProjectPath: path.resolve(info.packageDirectory, rojoProject),
	};
}
