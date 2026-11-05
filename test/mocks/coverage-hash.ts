import type buffer from "node:buffer";
import { createHash } from "node:crypto";

import type { FileSystem } from "../../src/utils/file-system.ts";

export function sha256(data: buffer.Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export function sha256File(filePath: string, fileSystem: FileSystem): string {
	return sha256(fileSystem.readFileSync(filePath));
}

export function copyIgnoreHash(patterns: ReadonlyArray<string>): string {
	return sha256(JSON.stringify([...patterns].toSorted()));
}
