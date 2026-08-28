import type { Mount } from "@isentinel/rojo-utils";
import { findInTree } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import { dedupeMounts } from "../config/projects.ts";
import type { TypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { resolveLuauRoots } from "../coverage-pipeline/prepare.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import { stripTsExtension } from "../utils/extensions.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import { TYPE_TEST_PATTERN } from "./discovery.ts";

/**
 * Map each compiled-Luau root to its Rojo mount (FS path ↔ DataModel path) via
 * the Rojo tree. Roots that don't map (a compiled-output dir the Rojo project
 * doesn't mount) are skipped; mounts are de-duplicated by DataModel path so
 * two roots resolving to the same mount yield one entry.
 */
export function deriveProjectMounts(
	luauRoots: ReadonlyArray<string>,
	rojoTree: RojoTreeNode,
): Array<Mount> {
	const mounts = luauRoots.flatMap((luauRoot) => {
		// `findInTree` does an exact string match. Thus a root written
		// "out/shared/" or "./out/shared" must first become "out/shared", or
		// it does not find the mount that it names.
		const fsPath = toPosixRoot(luauRoot);
		const dataModelPath = findInTree(rojoTree, fsPath, "");
		return dataModelPath !== undefined ? [{ dataModelPath, fsPath }] : [];
	});

	return dedupeMounts(mounts);
}

/**
 * Build the single `ResolvedProjectConfig` a no-`projects` config collapses
 * to.
 *
 * A bare config carries no explicit `projects`, but the Luau runner resolves
 * per-project config from a `jest.config` ModuleScript at each project root,
 * so it must route through the multi pipeline (stub generation + place
 * rebuild). The project roots are derived from the config's luau roots mapped
 * through the Rojo tree — the same mounts the coverage manifest uses.
 * Discovery is preserved by feeding the root `testMatch` straight through as
 * `include` (this never reaches `resolveProjectConfig`, so a rootless glob is
 * fine).
 *
 * `rojoTree` is `undefined` for a `--typecheckOnly` run, which is pure-local
 * tsgo: no backend, no place, nothing mounted into a DataModel. Such a run
 * needs no Rojo project **on disk** at all, so the tree is never loaded and
 * the project carries no mounts. The "no mounts" `ConfigError` therefore only
 * fires when a tree was actually consulted.
 */
export function buildImplicitProject(
	config: ResolvedConfig,
	rojoTree: RojoTreeNode | undefined,
): ResolvedProjectConfig {
	const mounts =
		rojoTree === undefined ? [] : deriveProjectMounts(resolveLuauRoots(config), rojoTree);
	if (rojoTree !== undefined && mounts.length === 0) {
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
	const runtimeGlobs = config.testMatch.filter((glob) => !matchesTypeTestGlob(glob));

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
		typecheck: resolveImplicitTypecheck(config),
	};
}

function matchesTypeTestGlob(glob: string): boolean {
	return TYPE_TEST_PATTERN.test(glob);
}

/**
 * Seed the implicit project's `typecheck.include` from the `-d` globs the root
 * `testMatch` already carries. `include` strips them (see above) and the multi
 * pipeline derives Type Tests from `include`, so without this a config whose
 * `testMatch` is *only* `-d` globs discovers nothing. An explicit
 * `test.typecheck.include` wins, and an empty derivation is left unset so
 * `deriveTypecheckInclude` still runs off the runtime globs.
 */
function resolveImplicitTypecheck(config: ResolvedConfig): TypecheckConfig | undefined {
	const include = config.typecheck?.include ?? config.testMatch.filter(matchesTypeTestGlob);
	if (include.length === 0) {
		return config.typecheck;
	}

	return { ...config.typecheck, include };
}

// Mirror `resolveProjectConfig`'s `testMatch` derivation: strip the test-file
// extension, then qualify a bare basename glob with `**/` so it matches at any
// depth (the runner matches Instance-namespace paths) — keeping the implicit
// project's matcher identical to a configured project's for the same globs.
function toTestMatchPattern(glob: string): string {
	const stripped = stripTsExtension(glob);
	return stripped.includes("/") ? stripped : `**/${stripped}`;
}

function resolveDisplayName({ displayName, rootDir }: ResolvedConfig): string {
	const name = typeof displayName === "string" ? displayName : displayName?.name;
	// `path.normalize` strips a trailing separator so `basename` doesn't return
	// "" for a `rootDir` like "/pkg/".
	return name !== undefined && name !== "" ? name : path.basename(path.normalize(rootDir));
}
