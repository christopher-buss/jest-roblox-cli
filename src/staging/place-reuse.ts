import { type } from "arktype";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { CoverageManifest } from "../coverage-data/manifest.ts";
import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { tryComputeRojoInputsHashAsync } from "./rojo-inputs.ts";

/** What a previous build recorded: its inputs key and place hash. */
export interface PlaceReuseRecord {
	/** Key the build's inputs hashed to. */
	inputsKey: string;
	/** Hash of the place the build wrote. */
	placeHash: string;
}

const placeReuseSchema = type({ inputsKey: "string", placeHash: "string" });

/** Inputs to {@link computePlaceInputsKeyAsync}. */
export interface PlaceInputsKeyOptions {
	/** Where input digests are cached between runs. */
	digestCacheFile: string;
	/** Where the inputs are read. */
	fileSystem: FileSystem;
	/** Content hashes for the instrumented trees, folded in without a walk. */
	manifests: Array<CoverageManifest>;
	/** Where the project will be written. */
	projectFile: string;
	/**
	 * The synthesized project with relative `$path`s, before staging passes.
	 */
	projectJson: string;
	/** Shadow directories the manifests cover, left out of the walk. */
	shadowRoots: Array<string>;
	/** One version per staging pass run after this key. */
	stagingVersions: ReadonlyArray<number>;
}

/**
 * Fingerprint everything the synthesized place is built from.
 * @param options - Project, manifests, shadow roots and pass versions.
 * @returns A hex SHA-256 key, or `undefined` when the inputs cannot be hashed.
 */
export async function computePlaceInputsKeyAsync(
	options: PlaceInputsKeyOptions,
): Promise<string | undefined> {
	const rojoHash = await tryComputeRojoInputsHashAsync({
		digestCacheFile: options.digestCacheFile,
		fileSystem: options.fileSystem,
		luauRoots: options.shadowRoots,
		projectJson: options.projectJson,
		rojoProjectPath: options.projectFile,
		rootDirectory: path.dirname(options.projectFile),
	});
	if (rojoHash === undefined) {
		return undefined;
	}

	const digest = createHash("sha256").update(rojoHash);
	digest.update(`s\0${options.stagingVersions.join("\0")}`);
	for (const line of manifestLines(options.manifests)) {
		digest.update(line);
	}

	return digest.digest("hex");
}

/**
 * The record a previous build left.
 * @param cacheFile - Path of the record.
 * @param fileSystem - Reads the record.
 * @returns The record, or `undefined` when it is missing or malformed.
 */
export function readPlaceReuseRecord(
	cacheFile: string,
	fileSystem: FileSystem,
): PlaceReuseRecord | undefined {
	let raw: string;
	try {
		raw = fileSystem.readFileSync(cacheFile, "utf-8");
	} catch {
		return undefined;
	}

	try {
		const parsed = placeReuseSchema(JSON.parse(raw));
		return parsed instanceof type.errors ? undefined : parsed;
	} catch {
		return undefined;
	}
}

/**
 * Write the record atomically, replacing any previous one.
 * @param options - The record and where it goes.
 * @param options.cacheFile - Path of the record.
 * @param options.fileSystem - Writes the record.
 * @param options.record - Key and place hash to record.
 */
export function writePlaceReuseRecord({
	cacheFile,
	fileSystem,
	record,
}: {
	cacheFile: string;
	fileSystem: FileSystem;
	record: PlaceReuseRecord;
}): void {
	atomicWrite({ contents: JSON.stringify(record), fileSystem, targetPath: cacheFile });
}

function manifestLines(manifests: Array<CoverageManifest>): Array<string> {
	return manifests
		.flatMap((manifest) => {
			const shadowDirectory = normalizeWindowsPath(manifest.shadowDir);
			return [
				`v\0${String(manifest.instrumenterVersion)}\0${shadowDirectory}`,
				...Object.entries(manifest.files).map(([key, record]) => {
					return `f\0${key}\0${record.sourceHash}`;
				}),
				...Object.entries(manifest.nonInstrumentedFiles).map(([key, record]) => {
					return `n\0${key}\0${record.sourceHash}`;
				}),
			];
		})
		.sort();
}
