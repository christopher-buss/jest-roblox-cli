import { isOptionalPath, resolveMountPath } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";

import type { CoverageRoot } from "../coverage-pipeline/redirect-path.ts";
import { redirectPathToShadow } from "../coverage-pipeline/redirect-path.ts";
import {
	collectRojoMounts,
	unreachableRootWarning,
} from "../coverage-pipeline/root-reachability.ts";
import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { UnwrappedPackageDescriptor } from "./synthesizer-types.ts";
import { isTreeNode } from "./tree-node-guards.ts";

interface AbsolutizeOptions {
	/** Each `luauRoot` made absolute, so the walk resolves it once. */
	coverageRoots: Array<CoverageRoot> | undefined;
	fileSystem: FileSystem;
	/**
	 * Absolute spine directory, by the absolute source directory it stands
	 * in for.
	 */
	spine: Map<string, string> | undefined;
}

/**
 * Both the wrap and no-wrap paths absolutize a package's tree through here.
 * @param options - Package descriptor, file system and tree.
 * @param options.descriptor - Package whose coverage roots and spine apply.
 * @param options.fileSystem - Reads directories under demoted mounts.
 * @param options.node - Tree as the project file wrote it.
 * @returns A copy of the tree with absolute, shadow-redirected `$path` values.
 */
export function absolutizePackagePaths({
	descriptor,
	fileSystem,
	node,
}: {
	descriptor: UnwrappedPackageDescriptor;
	fileSystem: FileSystem;
	node: RojoTreeNode;
}): RojoTreeNode {
	// Before the walk, while every `$path` still reads as the project wrote it.
	warnUnreachableCoverageRoots(descriptor, node);
	return absolutizePaths({
		node,
		options: {
			coverageRoots: resolveCoverageRoots(
				descriptor.packageDirectory,
				descriptor.coverageRoots,
			),
			fileSystem,
			spine: resolveSpine(descriptor),
		},
		treeBase: path.dirname(descriptor.rojoProjectPath),
	});
}

/**
 * `$path` resolves against the rojo project directory per rojo's convention.
 * `luauRoot` resolves against `coverageBase` (the package directory) because
 * that's the documented contract for coverage roots, and the two diverge
 * whenever a project file lives in a subdirectory of its package. The
 * resolved path goes back through `toPosixRoot`, so `$path: "out/"` and a
 * root `path.resolve` left with a trailing separator still match `out`.
 * @param coverageBase - Package directory that roots resolve against.
 * @param coverageRoots - Roots as the config wrote them.
 * @returns Absolute roots, or `undefined` when none are configured.
 */
function resolveCoverageRoots(
	coverageBase: string,
	coverageRoots: Array<CoverageRoot> | undefined,
): Array<CoverageRoot> | undefined {
	return coverageRoots?.map((root) => {
		return {
			luauRoot: toPosixRoot(path.resolve(coverageBase, root.luauRoot)),
			shadowDir: normalizeWindowsPath(root.shadowDir),
		};
	});
}

/**
 * The spine directory for each source directory it stands in for, resolved the
 * same way `resolveCoverageRoots` resolves a root.
 * @param descriptor - Package whose coverage spine applies.
 * @returns Spine directory by source directory, or `undefined` without a spine.
 */
function resolveSpine(descriptor: UnwrappedPackageDescriptor): Map<string, string> | undefined {
	const resolved = resolveCoverageRoots(descriptor.packageDirectory, descriptor.coverageSpine);
	return resolved === undefined
		? undefined
		: new Map(resolved.map((entry) => [entry.luauRoot, entry.shadowDir]));
}

/**
 * Say so when a coverage root no `$path` in this project reaches — off the
 * tree entirely, or nested below the mount that contains it. Either way the
 * shadow is built and the place loads the originals, so the run reports zero
 * coverage for that root with nothing else to show for the work.
 *
 * Workspace mode drops such a root before it reaches synthesis, so what this
 * catches in practice is single and multi mode, where `luauRoots` comes
 * straight from the config with no mount check of its own. No `subject`: the
 * descriptor there names a synthetic package the user never wrote.
 * @param descriptor - Package whose coverage roots are checked.
 * @param tree - Unresolved tree whose mounts the roots must reach.
 */
function warnUnreachableCoverageRoots(
	descriptor: UnwrappedPackageDescriptor,
	tree: RojoTreeNode,
): void {
	const { coverageRoots } = descriptor;
	if (coverageRoots === undefined) {
		return;
	}

	const mounts = collectRojoMounts(tree, path.dirname(descriptor.rojoProjectPath));
	for (const root of coverageRoots) {
		const warning = unreachableRootWarning({
			base: descriptor.packageDirectory,
			mounts,
			rawRoot: root.luauRoot,
		});
		if (warning !== undefined) {
			process.stderr.write(warning);
		}
	}
}

function resolveDollarPath(absoluteTarget: string, options: AbsolutizeOptions): string {
	if (options.coverageRoots === undefined) {
		return absoluteTarget;
	}

	return redirectPathToShadow(absoluteTarget, options.coverageRoots) ?? absoluteTarget;
}

function absolutizePaths({
	node,
	options,
	treeBase,
}: {
	node: RojoTreeNode;
	options: AbsolutizeOptions;
	treeBase: string;
}): RojoTreeNode {
	const result: RojoTreeNode = {};
	let mountTarget: string | undefined;
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string") {
			mountTarget = normalizeWindowsPath(resolveMountPath(treeBase, value));
			result[key] = resolveDollarPath(mountTarget, options);
			continue;
		}

		if (key === "$path" && isOptionalPath(value)) {
			mountTarget = normalizeWindowsPath(resolveMountPath(treeBase, value.optional));
			result[key] = { optional: resolveDollarPath(mountTarget, options) };
			continue;
		}

		if (!key.startsWith("$") && isTreeNode(value)) {
			result[key] = absolutizePaths({ node: value, options, treeBase });
			continue;
		}

		result[key] = value;
	}

	// After the loop, so a name the project declares for itself wins over the
	// sibling node the demote would otherwise invent for the same directory.
	return mountTarget === undefined
		? result
		: demoteToSpine({ absoluteTarget: mountTarget, node: result, options });
}

/**
 * The node one directory under a demoted mount becomes: the shadow when it is
 * a coverage root, a demote of its own when the spine carries on through it,
 * and the original directory otherwise.
 * @param absoluteTarget - Absolute directory the child node mounts.
 * @param options - Coverage roots, spine and file system.
 * @returns The child node for that directory.
 */
function spineChildNode(absoluteTarget: string, options: AbsolutizeOptions): RojoTreeNode {
	// `demoteToSpine` hands a node it does not demote straight back, so the
	// fallback is the node it is given rather than a second lookup here.
	return demoteToSpine({
		absoluteTarget,
		node: { $path: resolveDollarPath(absoluteTarget, options) },
		options,
	});
}

/**
 * Rojo mounts a directory whole, so a coverage root below a `$path` cannot be
 * swapped in place: the mount keeps serving the originals. Demoting moves the
 * mount's `$path` onto a spine directory holding that directory's own loose
 * files — which is what keeps an `init.luau`, a `.meta.json` and every
 * extension rojo mounts for itself working — and promotes each directory
 * beneath it to an explicit child, pointed at the shadow or back at the source.
 *
 * A name the project already declares is left alone: it is the author's node,
 * and rojo would build both.
 * @param options - Mount target, node and absolutize options.
 * @param options.absoluteTarget - Absolute directory the node mounts.
 * @param options.node - Node to demote; mutated in place.
 * @param options.options - Coverage roots, spine and file system.
 * @returns The same node, demoted when the spine covers its target.
 */
function demoteToSpine({
	absoluteTarget,
	node,
	options,
}: {
	absoluteTarget: string;
	node: RojoTreeNode;
	options: AbsolutizeOptions;
}): RojoTreeNode {
	const spineDirectory = options.spine?.get(absoluteTarget);
	if (spineDirectory === undefined) {
		return node;
	}

	node.$path = spineDirectory;
	const entries = options.fileSystem.readdirSync(absoluteTarget, { withFileTypes: true });
	for (const entry of entries) {
		// A dollar-prefixed disk entry collides with rojo's own reserved keys,
		// the same reason `demoteAutoMountToExplicit` passes over one.
		if (!entry.isDirectory() || entry.name.startsWith("$") || node[entry.name] !== undefined) {
			continue;
		}

		node[entry.name] = spineChildNode(path.posix.join(absoluteTarget, entry.name), options);
	}

	return node;
}
