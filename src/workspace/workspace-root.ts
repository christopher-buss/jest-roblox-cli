import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";

export const PNPM_MARKER = "pnpm-workspace.yaml";
export const TURBO_MARKER = "turbo.json";
export const NX_MARKER = "nx.json";

const MARKERS = [PNPM_MARKER, TURBO_MARKER, NX_MARKER] as const;

/**
 * Walk up from `cwd` to the nearest directory with a pnpm, turbo or nx marker.
 * @param cwd - Directory to start from.
 * @param fileSystem - File system to probe.
 * @returns The workspace root directory, or `undefined` when no ancestor holds
 *   a marker.
 */
export function findWorkspaceRoot(cwd: string, fileSystem: FileSystem): string | undefined {
	let current = path.resolve(cwd);
	while (!hasWorkspaceMarker(fileSystem, current)) {
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}

		current = parent;
	}

	return current;
}

/**
 * Walk up from `cwd` to the nearest directory with a pnpm, turbo or nx marker.
 * @param cwd - Directory to start from.
 * @param fileSystem - File system to probe.
 * @returns The workspace root directory.
 * @throws {Error} When no ancestor holds a marker.
 */
export function discoverWorkspaceRoot(cwd: string, fileSystem: FileSystem): string {
	const root = findWorkspaceRoot(cwd, fileSystem);
	if (root === undefined) {
		throw new Error(
			"No workspace root found. Expected one of pnpm-workspace.yaml / turbo.json / nx.json above cwd.",
		);
	}

	return root;
}

function hasWorkspaceMarker(fileSystem: FileSystem, directory: string): boolean {
	return MARKERS.some((marker) => fileSystem.existsSync(path.join(directory, marker)));
}
