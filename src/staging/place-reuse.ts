import { type } from "arktype";
import { createHash } from "node:crypto";
import * as path from "node:path";

import type { CoverageManifest } from "../coverage-pipeline/manifest.ts";
import { tryComputeRojoInputsHashAsync } from "../coverage-pipeline/rojo-inputs.ts";
import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/**
 * What a previous build recorded: the key its inputs hashed to, and the hash of
 * the place it produced. The place hash is what proves the `.rbxl` still on
 * disk is the one that key was recorded against, rather than a half-written
 * file an interrupted build left behind.
 */
export interface PlaceReuseRecord {
	inputsKey: string;
	placeHash: string;
}

const placeReuseSchema = type({ inputsKey: "string", placeHash: "string" });

export interface PlaceInputsKeyOptions {
	/** Forwarded to `openInputDigestCache`, which says what it claims. */
	digestCacheFile: string;
	/** Where the inputs are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/**
	 * Content hashes for the instrumented trees, folded in instead of walking
	 * them. Instrumentation already recorded a hash per source file, so
	 * re-reading the shadow output would pay again for what is on hand.
	 */
	manifests: Array<CoverageManifest>;
	/** Where the project will be written — the frame its mounts resolve in. */
	projectFile: string;
	/**
	 * The project as synthesized, with its `$path`s already made relative to
	 * `projectFile` but before the pinned-mount pass rewrites it. Taken as
	 * text rather than read back from `projectFile` so the key is available
	 * before that pass runs.
	 *
	 * Relative because that is the frame the built place is expressed in —
	 * rojo matches `globIgnorePaths` against a `$path` as written — and
	 * running the rewrite here puts its own rule inside the key. The walk
	 * itself reads either frame.
	 *
	 * What the staging passes then write is a function of this text, of the
	 * mount trees the walk below covers, and of their own code — which
	 * `stagingVersions` stands in for. A key that matches therefore says it
	 * would write what it wrote last time, which a reused place holds.
	 */
	projectJson: string;
	/**
	 * Mounts to leave out of the filesystem walk — the shadow directories the
	 * manifests above already account for.
	 */
	shadowRoots: Array<string>;
	/**
	 * One version per staging pass standing between this key and the built
	 * place. They are code rather than inputs, so nothing on disk moves when
	 * what they emit changes, and a place built by the old rule would read as
	 * current. Supplied by the caller that runs them.
	 */
	stagingVersions: ReadonlyArray<number>;
}

/**
 * Fingerprint everything the synthesized place is built from.
 *
 * Two sources, because the cheap one covers the bulk: the instrumented trees
 * come from manifest hashes already in memory, and only what is left — game
 * assets, `include/`, vendored packages, stubs, the project files — is walked.
 * Walking the instrumented trees as well is correct but roughly four times the
 * cost, and buys nothing the manifests do not already say.
 *
 * Reports `undefined` when the inputs cannot be fingerprinted (a malformed
 * project). The caller then rebuilds, which is what would have happened
 * without a cache at all.
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
		// Mounts are expressed relative to the project file, so that is the
		// only root the walk can key against.
		rootDirectory: path.dirname(options.projectFile),
	});
	if (rojoHash === undefined) {
		return undefined;
	}

	const digest = createHash("sha256").update(rojoHash);
	// Separated rather than concatenated: `[1, 2]` and `[12]` are different
	// rules, and a key that cannot tell them apart would reuse across a bump.
	digest.update(`s\0${options.stagingVersions.join("\0")}`);
	for (const line of manifestLines(options.manifests)) {
		digest.update(line);
	}

	return digest.digest("hex");
}

export function readPlaceReuseRecord(
	cacheFile: string,
	fileSystem: FileSystem = nodeFileSystem,
): PlaceReuseRecord | undefined {
	let raw: string;
	try {
		raw = fileSystem.readFileSync(cacheFile, "utf-8");
	} catch {
		// No previous build, or it was cleaned away. Not a fault.
		return undefined;
	}

	try {
		const parsed = placeReuseSchema(JSON.parse(raw));
		return parsed instanceof type.errors ? undefined : parsed;
	} catch {
		// A truncated or hand-edited record reads as "no cache".
		return undefined;
	}
}

export function writePlaceReuseRecord(
	cacheFile: string,
	record: PlaceReuseRecord,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	// Atomic, like the manifests it sits beside: a torn record read back as a
	// key match would hand out a place that was never built.
	atomicWrite({ contents: JSON.stringify(record), fileSystem, targetPath: cacheFile });
}

/**
 * One sorted line per instrumented and non-instrumented file, plus the
 * instrumenter version — a bump changes the shadow output while every
 * `sourceHash` stays put, so without it a stale place would look current.
 */
function manifestLines(manifests: Array<CoverageManifest>): Array<string> {
	const lines: Array<string> = [];
	for (const manifest of manifests) {
		// Canonicalized: `shadowDir` arrives as a native absolute path, and a
		// drive-letter or separator difference would read as a changed input.
		const shadowDirectory = normalizeWindowsPath(manifest.shadowDir);
		lines.push(`v\0${String(manifest.instrumenterVersion)}\0${shadowDirectory}`);
		for (const [key, record] of Object.entries(manifest.files)) {
			lines.push(`f\0${key}\0${record.sourceHash}`);
		}

		for (const [key, record] of Object.entries(manifest.nonInstrumentedFiles)) {
			lines.push(`n\0${key}\0${record.sourceHash}`);
		}
	}

	lines.sort();
	return lines;
}
