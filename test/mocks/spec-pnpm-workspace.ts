import * as path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";

export const ROOT = path.resolve("/repo");

const STATE_PATH = path.join(ROOT, "node_modules/.pnpm-workspace-state-v1.json");
export const YAML_PATH = path.join(ROOT, "pnpm-workspace.yaml");

const INSTALLED_AT = Date.UTC(2026, 0, 2);
const BEFORE_INSTALL = new Date(Date.UTC(2026, 0, 1));

export function writeInstalledWorkspace(
	files: Record<string, string>,
	projects: Record<string, { name: string }>,
): FileSystem {
	const { fileSystem, volume } = createMemoryFileSystem({
		...files,
		[STATE_PATH]: JSON.stringify({ lastValidatedTimestamp: INSTALLED_AT, projects }),
		[YAML_PATH]: "packages:\n  - packages/*\n",
	});

	volume.utimesSync(YAML_PATH, BEFORE_INSTALL, BEFORE_INSTALL);
	return fileSystem;
}
