import type { Mount } from "@isentinel/rojo-utils";
import { findInTree } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { dedupeMounts } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { resolveLuauRoots } from "../coverage-pipeline/prepare.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { stripTsExtension } from "../utils/extensions.ts";
import { TYPE_TEST_PATTERN } from "./discovery.ts";

/**
 * Map each compiled-Luau root to its Rojo mount (FS path ↔ DataModel path) via
 * the Rojo tree. Roots that don't map (a compiled-output dir the Rojo project
 * doesn't mount) are skipped; mounts are de-duplicated by DataModel path so two
 * roots resolving to the same mount yield one entry.
 */
export function deriveProjectMounts(
	luauRoots: ReadonlyArray<string>,
	rojoTree: RojoTreeNode,
): Array<Mount> {
	const mounts = luauRoots.flatMap((luauRoot) => {
		// Strip a trailing separator before the lookup, mirroring
		// `mapFsRootToDataModel` — a tsconfig `outDir` like "out/shared/" must
		// still match the Rojo `$path: "out/shared"` mount.
		const fsPath = luauRoot.replace(/\/$/, "");
		const dataModelPath = findInTree(rojoTree, fsPath, "");
		return dataModelPath !== undefined ? [{ dataModelPath, fsPath }] : [];
	});

	return dedupeMounts(mounts);
}

/**
 * Build the single `ResolvedProjectConfig` a no-`projects` config collapses to.
 *
 * Single mode carries no explicit `projects`, but the Luau runner resolves
 * per-project config from a `jest.config` ModuleScript at each project root, so
 * a bare config must route through the multi pipeline (stub generation + place
 * rebuild). The project roots are derived from the config's luau roots mapped
 * through the Rojo tree — the same mounts the coverage manifest uses. Discovery
 * is preserved by feeding the root `testMatch` straight through as `include`
 * (this never reaches `resolveProjectConfig`, so a rootless glob is fine).
 */
export function buildImplicitProject(
	config: ResolvedConfig,
	rojoTree: RojoTreeNode,
): ResolvedProjectConfig {
	const mounts = deriveProjectMounts(resolveLuauRoots(config), rojoTree);
	if (mounts.length === 0) {
		throw new ConfigError(
			"No test projects could be derived: none of the resolved luauRoots map to a $path mount in your Rojo project.",
			'Set "projects" in your test config (e.g. ["ReplicatedStorage/shared"]), or point "luauRoots" at a compiled-output directory your Rojo project mounts.',
		);
	}

	// Runtime globs only. Type-Test (`-d`) globs must stay out of `include`: the
	// multi pipeline re-derives them from `include` (`deriveTypecheckInclude`),
	// and `deriveCoverageFromIncludes` runs `inferSourceExtension` on every
	// `include` entry — a `-d` glob has no `.spec`/`.test` source extension and
	// would throw, crashing a `--coverage` run. Mirrors `resolveProjectConfig`,
	// which never folds `-d` globs into a project's `include`.
	const runtimeGlobs = config.testMatch.filter((glob) => !TYPE_TEST_PATTERN.test(glob));

	const singleMount = mounts.length === 1 ? mounts[0] : undefined;
	const displayColor =
		typeof config.displayName === "string" ? undefined : config.displayName?.color;
	return {
		config,
		displayColor,
		displayName: resolveDisplayName(config),
		exclude: config.exclude ?? [],
		include: runtimeGlobs,
		outDir: singleMount?.fsPath,
		projects: mounts.map((mount) => mount.dataModelPath),
		rojoMounts: mounts,
		testMatch: [...new Set(runtimeGlobs.map(toTestMatchPattern))],
		typecheck: config.typecheck,
	};
}

// Mirror `resolveProjectConfig`'s `testMatch` derivation: strip the test-file
// extension, then qualify a bare basename glob with `**/` so it matches at any
// depth (the runner matches Instance-namespace paths) — keeping the implicit
// project's matcher identical to a configured project's for the same globs.
function toTestMatchPattern(glob: string): string {
	const stripped = stripTsExtension(glob);
	return stripped.includes("/") ? stripped : `**/${stripped}`;
}

function resolveDisplayName(config: ResolvedConfig): string {
	const { displayName, rootDir } = config;
	const name = typeof displayName === "string" ? displayName : displayName?.name;
	// `path.normalize` strips a trailing separator so `basename` doesn't return
	// "" for a `rootDir` like "/pkg/".
	return name !== undefined && name !== "" ? name : path.basename(path.normalize(rootDir));
}
