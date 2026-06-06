import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";

import { atomicWrite } from "../utils/atomic-write.ts";
import { hashFile } from "../utils/hash.ts";
import { parseVersionedManifest } from "./manifest-parse.ts";

/**
 * On-disk format version for `build-manifest.json`. Independent of
 * `MANIFEST_VERSION` (the coverage manifest's version) — the two siblings
 * version separately and are cross-linked by `buildId`.
 */
export const BUILD_MANIFEST_VERSION = 1 as const;

export interface BuildManifestProject {
	displayName: string;
	jestDataModelPath?: string;
	projectDataModelPath: string;
	setupFiles: Array<string>;
	setupFilesAfterEnv: Array<string>;
	testMatch: Array<string>;
}

export interface BuildManifestFileRecord {
	sourceHash: string;
}

export interface BuildManifestArtifact {
	hash: string;
	path: string;
}

export interface BuildManifest {
	/** Shared UUID linking this manifest to its sibling `CoverageManifest`. */
	buildId: string;
	cleanPlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, keyed by package-relative POSIX path. */
	files: Record<string, BuildManifestFileRecord>;
	generatedAt: string;
	projects: Array<BuildManifestProject>;
	version: typeof BUILD_MANIFEST_VERSION;
}

export type ReadBuildManifestResult =
	| { actual: string; expected: string; kind: "buildid-mismatch" }
	| { actual: string; expected: string; kind: "clean-place-hash-mismatch"; path: string }
	| { actual: string; expected: string; kind: "source-drift"; path: string }
	| { actual: unknown; expected: number; kind: "version-mismatch" }
	| { kind: "invalid"; summary: string }
	| { kind: "malformed-json" }
	| { kind: "missing" }
	| { kind: "missing-referenced-artifact"; path: string }
	| { kind: "ok"; manifest: BuildManifest };

export interface ReadBuildManifestOptions {
	/** When set, refuse if the manifest's `buildId` differs from this value. */
	expectedBuildId?: string;
	/** Base for resolving `cleanPlace.path` and `files` keys when re-hashing. */
	rootDir?: string;
}

const projectSchema = type({
	"displayName": "string",
	"jestDataModelPath?": "string",
	"projectDataModelPath": "string",
	"setupFiles": "string[]",
	"setupFilesAfterEnv": "string[]",
	"testMatch": "string[]",
}).as<BuildManifestProject>();

const fileRecordSchema = type({ sourceHash: "string" }).as<BuildManifestFileRecord>();

const artifactSchema = type({ hash: "string", path: "string" }).as<BuildManifestArtifact>();

export const buildManifestSchema: type<BuildManifest> = type({
	buildId: "string",
	cleanPlace: artifactSchema,
	files: type({ "[string]": fileRecordSchema }),
	generatedAt: "string",
	projects: projectSchema.array(),
	version: type.unit(BUILD_MANIFEST_VERSION),
}).as<BuildManifest>();

type VerifyResult = { actual: string; kind: "mismatch" } | { kind: "missing" } | { kind: "ok" };

export function writeBuildManifest(filePath: string, manifest: BuildManifest): void {
	atomicWrite(filePath, JSON.stringify(manifest, undefined, "\t"));
}

export function readBuildManifest(
	filePath: string,
	options: ReadBuildManifestOptions = {},
): ReadBuildManifestResult {
	const parsed = parseVersionedManifest(filePath, buildManifestSchema, BUILD_MANIFEST_VERSION);
	if (parsed.kind !== "ok") {
		return parsed;
	}

	const { manifest } = parsed;
	const { expectedBuildId, rootDir: rootDirectory } = options;

	if (expectedBuildId !== undefined && manifest.buildId !== expectedBuildId) {
		return { actual: manifest.buildId, expected: expectedBuildId, kind: "buildid-mismatch" };
	}

	const cleanPlaceResult = verifyArtifact(
		manifest.cleanPlace.path,
		manifest.cleanPlace.hash,
		rootDirectory,
	);
	if (cleanPlaceResult.kind === "missing") {
		return { kind: "missing-referenced-artifact", path: manifest.cleanPlace.path };
	}

	if (cleanPlaceResult.kind === "mismatch") {
		return {
			actual: cleanPlaceResult.actual,
			expected: manifest.cleanPlace.hash,
			kind: "clean-place-hash-mismatch",
			path: manifest.cleanPlace.path,
		};
	}

	// Iterating in the manifest's recorded key order keeps "report the first
	// mismatch" deterministic without a comparator.
	for (const [key, record] of Object.entries(manifest.files)) {
		const result = verifyArtifact(key, record.sourceHash, rootDirectory);
		if (result.kind === "missing") {
			return { kind: "missing-referenced-artifact", path: key };
		}

		if (result.kind === "mismatch") {
			return {
				actual: result.actual,
				expected: record.sourceHash,
				kind: "source-drift",
				path: key,
			};
		}
	}

	return { kind: "ok", manifest };
}

function verifyArtifact(
	storedPath: string,
	expectedHash: string,
	rootDirectory: string | undefined,
): VerifyResult {
	const diskPath =
		rootDirectory === undefined ? storedPath : path.join(rootDirectory, storedPath);
	if (!fs.existsSync(diskPath)) {
		return { kind: "missing" };
	}

	const actual = hashFile(diskPath);
	if (actual !== expectedHash) {
		return { actual, kind: "mismatch" };
	}

	return { kind: "ok" };
}
