import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * Resolves a source-map `sources` entry. `mapper.ts` and
 * `instrument-universe.ts` must share this; do not copy it.
 * @param source - Entry from the source map's `sources`.
 * @param sourceMapDirectory - Directory holding the source map.
 * @returns Normalized source path.
 */
export function resolveSourcePath(source: string, sourceMapDirectory: string): string {
	const normalized = normalizeWindowsPath(source);
	if (!normalized.startsWith("..")) {
		return normalized;
	}

	return path.posix.normalize(path.posix.join(sourceMapDirectory, normalized));
}
