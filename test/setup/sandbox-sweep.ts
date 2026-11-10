import path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";

export const SANDBOX_PREFIX = "jest-roblox-cli-e2e-";

const STALE_AFTER_MS = 60 * 60 * 1000;

export interface SandboxSweep {
	readonly fileSystem: Pick<FileSystem, "existsSync" | "readdirSync" | "rmSync" | "statSync">;
	readonly now: number;
	readonly root: string;
}

/**
 * Only stale entries go: the root is shared with concurrent runs.
 * @param sweep - Root to sweep, the file system it lives on, and the time now.
 */
export function sweepStaleSandboxes({ fileSystem, now, root }: SandboxSweep): void {
	if (!fileSystem.existsSync(root)) {
		return;
	}

	const staleBefore = now - STALE_AFTER_MS;
	for (const entry of fileSystem.readdirSync(root)) {
		if (!entry.startsWith(SANDBOX_PREFIX)) {
			continue;
		}

		// `throwIfNoEntry`: a concurrent run can remove its sandbox meanwhile.
		const entryPath = path.join(root, entry);
		const stats = fileSystem.statSync(entryPath, { throwIfNoEntry: false });
		if (stats !== undefined && stats.mtimeMs < staleBefore) {
			fileSystem.rmSync(entryPath, { force: true, recursive: true });
		}
	}
}
