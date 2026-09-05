import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

export const PNPM_MARKER = "pnpm-workspace.yaml";
export const TURBO_MARKER = "turbo.json";
export const NX_MARKER = "nx.json";

const MARKERS = [PNPM_MARKER, TURBO_MARKER, NX_MARKER] as const;

export function discoverWorkspaceRoot(
	cwd: string,
	fileSystem: FileSystem = nodeFileSystem,
): string {
	let current = path.resolve(cwd);
	while (true) {
		if (hasWorkspaceMarker(fileSystem, current)) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			throw new Error(
				"No workspace root found. Expected one of pnpm-workspace.yaml / turbo.json / nx.json above cwd.",
			);
		}

		current = parent;
	}
}

function hasWorkspaceMarker(fileSystem: FileSystem, directory: string): boolean {
	return MARKERS.some((marker) => fileSystem.existsSync(path.join(directory, marker)));
}
