import type buffer from "node:buffer";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

export function hashBuffer(data: buffer.Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 of a file's raw bytes. The canonical helper for recording and
 * re-verifying artifact hashes — reads the file as a buffer so the digest
 * matches `hashBuffer` of the same content regardless of encoding.
 */
export function hashFile(filePath: string): string {
	return hashBuffer(fs.readFileSync(filePath));
}
