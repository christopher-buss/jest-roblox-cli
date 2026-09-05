import * as path from "node:path";

import type { FileSystem } from "../../src/utils/file-system.ts";

/** Far enough back that no test clock lands on it. */
const DEFAULT_AGE_SECONDS = 60;

/**
 * Back-date a file on an in-memory volume.
 *
 * `openInputDigestCache` records a digest only for a file whose mtime already
 * predates the run that read it, so a file written during a test is never
 * remembered and every spec wanting a warm digest cache has to age its inputs
 * first. `ageSeconds` is the knob for the case where two states of one file
 * must be told apart by timestamp alone.
 *
 * @param fileSystem - The volume holding the file.
 * @param filePath - The file to back-date.
 * @param ageSeconds - How far back to move its timestamps.
 */
export function ageFile(fileSystem: FileSystem, filePath: string, ageSeconds: number): void {
	const aged = new Date(Date.now() - ageSeconds * 1000);
	fileSystem.utimesSync(filePath, aged, aged);
}

/**
 * Write a file, parent directories included, and back-date it by
 * {@link DEFAULT_AGE_SECONDS}.
 *
 * @param fileSystem - The volume to write to.
 * @param filePath - Where the file lands.
 * @param contents - What to write.
 */
export function writeAgedFile(fileSystem: FileSystem, filePath: string, contents: string): void {
	fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
	fileSystem.writeFileSync(filePath, contents);
	ageFile(fileSystem, filePath, DEFAULT_AGE_SECONDS);
}
