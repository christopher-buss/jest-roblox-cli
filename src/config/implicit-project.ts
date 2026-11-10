import type { Mount, RojoTreeNode } from "@isentinel/rojo-utils";
import { findInTree } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { resolveLuauRoots } from "../shadow/luau-roots.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { stripTsExtension } from "../utils/extensions.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { isTypeTestFile } from "../utils/test-file-kind.ts";
import { ConfigError } from "./errors.ts";
import { dedupeMounts } from "./project-mounts.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import type { TypecheckConfig } from "./resolve-typecheck-config.ts";
import type { ResolvedConfig } from "./resolved-config.ts";

/** Inputs of {@link buildImplicitProject}. */
export interface BuildImplicitProjectOptions extends ImplicitProjectSeams {
	/** Root config without `projects`. */
	config: ResolvedConfig;
	/** Rojo tree; `undefined` on a `--typecheckOnly` run. */
	rojoTree: RojoTreeNode | undefined;
}

interface ImplicitProjectSeams {
	fileSystem: FileSystem;
	tsconfigReader: TsconfigReader;
}

/**
 * Build the one project a config without `projects` collapses to.
 * @param options - Config, Rojo tree and seams.
 * @param options.config - Root config without `projects`.
 * @param options.rojoTree - Rojo tree; `undefined` with `--typecheckOnly`.
 * @returns One project over the derived mounts and runtime globs.
 * @throws {ConfigError} When a Rojo tree is given and no root maps to a mount.
 */
export function buildImplicitProject({
	config,
	rojoTree,
	...seams
}: BuildImplicitProjectOptions): ResolvedProjectConfig {
	const mounts =
		rojoTree === undefined
			? []
			: deriveProjectMounts(resolveLuauRoots({ ...seams, config }), rojoTree);
	if (rojoTree !== undefined && mounts.length === 0) {
		throw new ConfigError(
			"No test projects could be derived: none of the resolved luauRoots map to a $path mount in your Rojo project.",
			'Set "projects" in your test config (e.g. ["ReplicatedStorage/shared"]), or point "luauRoots" at a compiled-output directory your Rojo project mounts.',
		);
	}

	const runtimeGlobs = config.testMatch.filter((glob) => !isTypeTestFile(glob));

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

function deriveProjectMounts(
	luauRoots: ReadonlyArray<PosixRoot>,
	rojoTree: RojoTreeNode,
): Array<Mount> {
	// `findInTree` matches exact strings, so the roots must arrive canonical.
	const mounts = luauRoots.flatMap((fsPath) => {
		const dataModelPath = findInTree({
			currentDataModelPath: "",
			node: rojoTree,
			targetPath: fsPath,
		});
		return dataModelPath !== undefined ? [{ dataModelPath, fsPath }] : [];
	});

	return dedupeMounts(mounts);
}

function resolveImplicitTypecheck(config: ResolvedConfig): TypecheckConfig | undefined {
	const include = config.typecheck?.include ?? config.testMatch.filter(isTypeTestFile);
	if (include.length === 0) {
		return config.typecheck;
	}

	return { ...config.typecheck, include };
}

/**
 * Mirrors `resolveProjectConfig`'s `testMatch` derivation.
 *
 * @param glob - Runtime `testMatch` glob.
 * @returns The runner-side `testMatch` pattern.
 */
function toTestMatchPattern(glob: string): string {
	const stripped = stripTsExtension(glob);
	return stripped.includes("/") ? stripped : `**/${stripped}`;
}

function resolveDisplayName({ displayName, rootDir }: ResolvedConfig): string {
	const name = typeof displayName === "string" ? displayName : displayName?.name;
	return name !== undefined && name !== "" ? name : path.basename(path.normalize(rootDir));
}
