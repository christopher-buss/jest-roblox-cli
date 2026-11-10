import type { FileSystem } from "../utils/file-system.ts";

// Not in `shadow-root.ts`: it imports `instrumentRoot`, so that would cycle.
// Read the entry type: `mkdirSync` onto a file throws in Node, not in memfs.

/**
 * Make one shadow directory, clearing a file on its path. One level only:
 * callers must walk parent-first.
 * @param shadowPath - Directory to create in the shadow.
 * @param fileSystem - Shadow filesystem. Defaults to the real filesystem.
 * @returns `true` when the directory did not exist before.
 */
export function createShadowDirectory(shadowPath: string, fileSystem: FileSystem): boolean {
	const existing = fileSystem.statSync(shadowPath, { throwIfNoEntry: false });
	if (existing?.isDirectory() === true) {
		return false;
	}

	if (existing !== undefined) {
		fileSystem.rmSync(shadowPath, { force: true });
	}

	fileSystem.mkdirSync(shadowPath, { recursive: true });
	return true;
}

/**
 * Clear a directory, with its subtree, on the path a shadow file has to take.
 * @param shadowPath - Path the shadow file will take.
 * @param fileSystem - Shadow filesystem. Defaults to the real filesystem.
 */
export function clearDirectoryAtFilePath(shadowPath: string, fileSystem: FileSystem): void {
	if (fileSystem.statSync(shadowPath, { throwIfNoEntry: false })?.isDirectory() === true) {
		fileSystem.rmSync(shadowPath, { force: true, recursive: true });
	}
}

/**
 * Whether a regular file is at the path; `existsSync` also matches folders.
 * @param shadowPath - Path to check in the shadow.
 * @param fileSystem - Shadow filesystem. Defaults to the real filesystem.
 * @returns `true` only when a regular file is at the path.
 */
export function shadowHoldsFile(shadowPath: string, fileSystem: FileSystem): boolean {
	return fileSystem.statSync(shadowPath, { throwIfNoEntry: false })?.isFile() === true;
}
