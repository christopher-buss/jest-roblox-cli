import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Carry a source-map `sources` entry back to a path the rest of the pipeline
 * can match on.
 *
 * Shared by the two halves of the coverage universe — `mapper.ts` resolving a
 * span's origin after the run, and `instrument-universe.ts` deciding whether a
 * file earns probes before it. They have to agree on what a compiled file's
 * source *is*, and a second copy of this rule is how they would stop agreeing.
 *
 * A relative entry is anchored to the directory holding the sidecar; anything
 * else is already the path the emitter meant.
 */
export function resolveSourcePath(source: string, sourceMapDirectory: string): string {
	const normalized = normalizeWindowsPath(source);
	if (!normalized.startsWith("..")) {
		return normalized;
	}

	return path.posix.normalize(path.posix.join(sourceMapDirectory, normalized));
}
