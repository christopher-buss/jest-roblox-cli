import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import type { CoverageManifest, ReadManifestResult } from "./manifest.ts";
import { readManifest } from "./manifest.ts";

type ManifestFailure = Exclude<ReadManifestResult, { kind: "ok" }>;

/**
 * Reads the previous run's manifest for cache reuse.
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
	return readUsableManifest({
		describeFailure: (failure) => describePriorFailure(failure, label),
		fileSystem,
		manifestPath,
	});
}

function readUsableManifest({
	describeFailure,
	fileSystem,
	manifestPath,
}: {
	describeFailure: (failure: ManifestFailure) => string | undefined;
	fileSystem: FileSystem;
	manifestPath: string;
}): CoverageManifest | undefined {
	const result = readManifest(manifestPath, fileSystem);
	if (result.kind === "ok") {
		return result.manifest;
	}

	const warning = describeFailure(result);
	if (warning !== undefined) {
		process.stderr.write(warning);
	}

	return undefined;
}

function describePriorFailure(failure: ManifestFailure, label: string): string | undefined {
	switch (failure.kind) {
		case "invalid": {
			return `Warning: ${label} is invalid (cache discarded): ${failure.summary}\n`;
		}
		case "malformed-json": {
			return `Warning: ${label} is malformed JSON (cache discarded)\n`;
		}
		case "missing":
		case "version-mismatch": {
			return undefined;
		}
	}
}
