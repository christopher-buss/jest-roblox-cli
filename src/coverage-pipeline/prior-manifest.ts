import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import type { CoverageManifest } from "./manifest.ts";
import { readManifest } from "./manifest.ts";

/**
 * Read the previous run's manifest for cache reuse. Warns on stderr when the
 * file is invalid or malformed JSON.
 * @param options - File system, label for warnings and manifest path.
 * @returns The manifest, or undefined when it is absent or unusable.
 */
export function loadPriorManifest({
	fileSystem,
	label,
	manifestPath,
}: {
	/** File system to read through. */
	fileSystem: FileSystem;
	/** Names the manifest in warnings. */
	label: string;
	/** Path of the manifest file. */
	manifestPath: string;
}): CoverageManifest | undefined {
	const result = readManifest(manifestPath, fileSystem);
	switch (result.kind) {
		case "invalid": {
			process.stderr.write(
				`Warning: ${label} is invalid (cache discarded): ${result.summary}
`,
			);
			return undefined;
		}
		case "malformed-json": {
			process.stderr.write(`Warning: ${label} is malformed JSON (cache discarded)
`);
			return undefined;
		}
		case "missing":
		case "version-mismatch": {
			return undefined;
		}
		case "ok": {
			return result.manifest;
		}
	}
}
