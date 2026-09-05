import type buffer from "node:buffer";
import { createHash } from "node:crypto";

import type { FileSystem } from "./file-system.ts";
import { nodeFileSystem } from "./file-system.ts";

export function hashBuffer(data: buffer.Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of a string, for digests over config rather than file bytes. */
export function hashString(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * SHA-256 of a file's raw bytes. The canonical helper for recording and
 * re-verifying artifact hashes — reads the file as a buffer so the digest
 * matches `hashBuffer` of the same content regardless of encoding.
 *
 * @param filePath - The file to digest.
 * @param fileSystem - Where to read it from.
 */
export function hashFile(filePath: string, fileSystem: FileSystem = nodeFileSystem): string {
	return hashBuffer(fileSystem.readFileSync(filePath));
}

/**
 * {@link hashFile} without holding the event loop. The fingerprint passes read
 * tens of thousands of files in a row, which is long enough that a synchronous
 * read starves every timer in the process — the stage block's repaint among
 * them, so a phase that spends its whole life here reports no progress at all.
 *
 * @param filePath - The file to digest.
 * @param fileSystem - Where to read it from.
 */
export async function hashFileAsync(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<string> {
	return hashBuffer(await fileSystem.promises.readFile(filePath));
}
