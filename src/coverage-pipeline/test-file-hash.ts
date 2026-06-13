import { existsSync } from "node:fs";

import type { SourceMapper } from "../source-mapper/index.ts";
import { hashFile } from "../utils/hash.ts";

/**
 * Resolve a test's source hash for per-test attribution: map its DataModel path
 * to a disk file via the source mapper, then hash that file's bytes. Returns
 * undefined when there is no mapper, the path doesn't resolve, or the file is
 * absent — the harvester records an empty hash in that case.
 */
export function resolveTestFileHash(
	sourceMapper: Pick<SourceMapper, "resolveTestFilePath"> | undefined,
	testFilePath: string,
): string | undefined {
	const diskPath = sourceMapper?.resolveTestFilePath(testFilePath);
	return diskPath !== undefined && existsSync(diskPath) ? hashFile(diskPath) : undefined;
}
