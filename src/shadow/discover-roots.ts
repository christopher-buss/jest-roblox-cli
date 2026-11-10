import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import {
	isWithinRoot,
	normalizeWindowsPath,
	toPosixRoot,
} from "../utils/normalize-windows-path.ts";
import {
	collectRojoMounts,
	containsMatchingFile,
	resolveMountWithin,
	unreachableRootWarning,
} from "./root-reachability.ts";

/** How explicit `luauRoots` are checked. */
export interface ExplicitRootCheck {
	/** Names the frame in the warning: "the package", "rootDir". */
	frameName: string;
	/** Who declared the roots, named in the warning. */
	subject?: string | undefined;
	/** Where a dropped root is reported. */
	warn: (text: string) => void;
}

/** What one root discovery reads. */
export interface RootDiscovery {
	/** Checks on explicit roots; absent before a build. */
	check: ExplicitRootCheck | undefined;
	/** The configured `luauRoots`; an empty list asks for auto-detection. */
	explicit: ReadonlyArray<string> | undefined;
	/** File system the roots are probed through. */
	fileSystem: FileSystem;
	/** Absolute directory the roots are written relative to. */
	frame: string;
	/** Accepts a file name that makes its directory a root. */
	holdsRoot: (name: string) => boolean;
	/** Matches a frame-relative root to skip. */
	isIgnored: (relative: string) => boolean;
	/** Absent when no rojo project could be read. */
	rojo: RojoTreeInFrame | undefined;
}

interface RojoTreeInFrame {
	rojoDirectory: string;
	tree: RojoTreeNode;
}

/**
 * The explicit `luauRoots` of one frame, or else its Luau-holding rojo mounts.
 * @param discovery - Frame, explicit roots, rojo tree and checks.
 * @returns Roots, or `undefined` when nothing names any.
 */
export function discoverLuauRoots(discovery: RootDiscovery): Array<PosixRoot> | undefined {
	if (discovery.explicit !== undefined && discovery.explicit.length > 0) {
		return discoverExplicitRoots(discovery, discovery.explicit);
	}

	if (discovery.rojo === undefined) {
		return undefined;
	}

	const roots = discoverMountedRoots(discovery, discovery.rojo);
	return roots.length > 0 ? roots : undefined;
}

/**
 * Any `.luau` or `.lua` file, specs included.
 * @param name - Name of the file to test.
 * @returns Whether the file is Luau.
 */
export function isLuauFile(name: string): boolean {
	return name.endsWith(".luau") || name.endsWith(".lua");
}

function isRbxtsIncludeRoot(fileSystem: FileSystem, directoryPath: string): boolean {
	return (
		fileSystem.existsSync(path.join(directoryPath, "RuntimeLib.lua")) ||
		fileSystem.existsSync(path.join(directoryPath, "RuntimeLib.luau"))
	);
}

function isLuauRoot(
	{ fileSystem, frame, holdsRoot, isIgnored }: RootDiscovery,
	relative: string,
): boolean {
	const directoryPath = path.resolve(frame, relative);
	return (
		!isIgnored(relative) &&
		fileSystem.existsSync(directoryPath) &&
		fileSystem.statSync(directoryPath).isDirectory() &&
		!isRbxtsIncludeRoot(fileSystem, directoryPath) &&
		containsMatchingFile(fileSystem, { directoryPath, matches: holdsRoot })
	);
}

function discoverMountedRoots(discovery: RootDiscovery, rojo: RojoTreeInFrame): Array<PosixRoot> {
	const rawPaths = collectRojoMounts(rojo.tree, rojo.rojoDirectory);
	const roots = new Set<PosixRoot>();
	for (const rawPath of rawPaths) {
		const relative = resolveMountWithin(rawPath, {
			frame: discovery.frame,
			rojoDirectory: rojo.rojoDirectory,
		});
		if (relative === undefined) {
			continue;
		}

		const root = toPosixRoot(relative);
		if (!roots.has(root) && isLuauRoot(discovery, root)) {
			roots.add(root);
		}
	}

	return [...roots];
}

function rejectExplicitRoot(
	{ check, frame, rojo }: RootDiscovery & { check: ExplicitRootCheck },
	rawRoot: string,
): string | undefined {
	const base = normalizeWindowsPath(path.resolve(frame));
	const root = normalizeWindowsPath(path.resolve(frame, rawRoot));
	if (root === base || !isWithinRoot(root, base)) {
		const owner = check.subject === undefined ? "" : ` in ${check.subject}`;
		return `Warning: luauRoot "${rawRoot}"${owner} is not a directory inside ${check.frameName}, so it reports no coverage.\n`;
	}

	if (rojo === undefined) {
		return undefined;
	}

	return unreachableRootWarning({
		base: frame,
		mounts: collectRojoMounts(rojo.tree, rojo.rojoDirectory),
		rawRoot,
		subject: check.subject,
	});
}

function discoverExplicitRoots(
	discovery: RootDiscovery,
	explicit: ReadonlyArray<string>,
): Array<PosixRoot> {
	const { check, frame } = discovery;
	if (check === undefined) {
		return [...new Set(explicit.map(toPosixRoot))];
	}

	const roots = new Set<PosixRoot>();
	for (const rawRoot of explicit) {
		const root = toPosixRoot(path.relative(frame, path.resolve(frame, rawRoot)));
		const warning = rejectExplicitRoot({ ...discovery, check }, rawRoot);
		if (warning !== undefined) {
			check.warn(warning);
		} else if (isLuauRoot(discovery, root)) {
			roots.add(root);
		}
	}

	return [...roots];
}
