import { Buffer } from "node:buffer";
import * as path from "node:path";

import { ConfigError } from "../config/errors.ts";
import { formatBytes } from "../progress/stages.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { CodeSplit } from "./code-split.ts";

/**
 * Open Cloud refuses a binary input larger than this, and a run that learns so
 * from the wire has already paid for the place and the bundle.
 */
export const MAX_CODE_BUNDLE_BYTES: number = 100 * 1024 * 1024;

/** What a Code Bundle is called, beside the place it was split from. */
const CODE_BUNDLE_SUFFIX = ".code-bundle.json";

/** The written Code Bundle and what a run reports about it. */
export interface CodeBundleArtifact {
	/** Size on disk, for the bundle stage line and the upload. */
	byteLength: number;
	/** How many source files it carries, for the same line. */
	fileCount: number;
	/** Absolute path of the written bundle file. */
	path: string;
	/**
	 * DataModel paths of the Code Mounts that had to stay in the harness, in
	 * the order the project declares them. A notice rather than an error: the
	 * run is correct either way, and this is the only thing that names what to
	 * move to get the rest of the speedup.
	 */
	stayedMounts: Array<string>;
}

/**
 * Write the Code Bundle beside its place and report what a run has to say
 * about it.
 *
 * The cap is checked before the file lands and before the place is built, so
 * a run too big for Open Cloud's binary input fails on a message naming the
 * cap rather than on a transport error several stages later.
 * @param options - Bundle contents and where it goes.
 * @param options.fileSystem - Writes the bundle file.
 * @param options.maximumBytes - Largest encoded size accepted.
 * @param options.placeFile - Place the bundle is written beside.
 * @param options.split - Code split whose bundle JSON is written.
 * @returns The written bundle's path, size, file count and stayed mounts.
 * @throws {ConfigError} When the encoded bundle exceeds `maximumBytes`.
 */
export function writeCodeBundle({
	fileSystem,
	maximumBytes,
	placeFile,
	split,
}: {
	fileSystem: FileSystem;
	maximumBytes: number;
	placeFile: string;
	split: CodeSplit;
}): CodeBundleArtifact {
	// Encoded once and written as bytes: the size and the file are the same
	// buffer, and a run's bundle is tens of megabytes to encode twice.
	const bytes = Buffer.from(split.bundleJson, "utf-8");
	if (bytes.length > maximumBytes) {
		throw new ConfigError(
			`The run's code comes to ${formatBytes(bytes.length)}, over the ${formatBytes(maximumBytes)} cap Open Cloud puts on a binary input.`,
			"Upload the code inside the place instead.",
		);
	}

	const bundleFile = codeBundleFileFor(placeFile);
	fileSystem.mkdirSync(path.dirname(bundleFile), { recursive: true });
	fileSystem.writeFileSync(bundleFile, bytes);
	return {
		byteLength: bytes.length,
		fileCount: split.fileCount,
		path: bundleFile,
		stayedMounts: split.stayedMounts,
	};
}

/**
 * Where the Code Bundle for a place goes: beside it, named after it.
 *
 * Named after the place rather than fixed, so two places built into one
 * directory cannot land on one bundle, and so a reader who found the place
 * knows which bundle answers for it.
 * @param placeFile - Path of the place file.
 * @returns Path of the bundle file for that place.
 */
function codeBundleFileFor(placeFile: string): string {
	const name = path.basename(placeFile, path.extname(placeFile));
	return path.join(path.dirname(placeFile), `${name}${CODE_BUNDLE_SUFFIX}`);
}
