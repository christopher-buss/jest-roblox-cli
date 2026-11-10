import * as path from "node:path";

import type { FileSystem } from "#src/utils/file-system.ts";

const DEFAULT_AGE_SECONDS = 60;

/**
 * `openInputDigestCache` records only files whose mtime predates the run.
 * @param fileSystem - File system that holds the file.
 * @param filePath - File to back-date.
 * @param ageSeconds - How far to move its mtime into the past.
 */
export function ageFile(fileSystem: FileSystem, filePath: string, ageSeconds: number): void {
	const aged = new Date(Date.now() - ageSeconds * 1000);
	fileSystem.utimesSync(filePath, aged, aged);
}

export function writeAgedFile(fileSystem: FileSystem, filePath: string, contents: string): void {
	fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
	fileSystem.writeFileSync(filePath, contents);
	ageFile(fileSystem, filePath, DEFAULT_AGE_SECONDS);
}
