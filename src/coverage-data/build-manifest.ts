import { type } from "arktype";
import * as path from "node:path";
import type { Except } from "type-fest";

import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { hashFile } from "../utils/hash.ts";
import { parseVersionedManifest } from "./manifest-parse.ts";

/** On-disk format version for `build-manifest.json`. */
export const BUILD_MANIFEST_VERSION = 2 as const;

/** Filename of the Build Manifest. */
export const BUILD_MANIFEST_FILE = "build-manifest.json";

/** One Jest project the built place carries. */
export interface BuildManifestProject {
	/** Project name shown in test output. */
	displayName: string;
	/** DataModel path of the Jest module, when the project names one. */
	jestDataModelPath?: string;
	/** DataModel path of the project's test root. */
	projectDataModelPath: string;
	/** Modules the kernel runs before the test framework loads. */
	setupFiles: Array<string>;
	/** Modules the kernel runs after the test framework loads. */
	setupFilesAfterEnv: Array<string>;
	/** Globs that select the project's test files. */
	testMatch: Array<string>;
}

/** Recorded state of one compiled source file. */
export interface BuildManifestFileRecord {
	/** SHA-256 of the file when the place was built. */
	sourceHash: string;
}

/** One place file the build produced. */
export interface BuildManifestArtifact {
	/** The Place Content Id stamped inside this place, if any. */
	contentId?: string;
	/** SHA-256 of the place file. */
	hash: string;
	/** Place file path, relative to the manifest root. */
	path: string;
}

/** Producer-side record of one build. */
export interface BuildManifest {
	/** Shared UUID linking this manifest to its sibling `CoverageManifest`. */
	buildId: string;
	/** The uninstrumented place, when `prepareArtifacts` built one. */
	cleanPlace?: BuildManifestArtifact;
	/** The coverage-instrumented place. */
	coveragePlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, keyed by package-relative path. */
	files: Record<string, BuildManifestFileRecord>;
	/** ISO timestamp of the build. */
	generatedAt: string;
	/** Jest projects the place carries. */
	projects: Array<BuildManifestProject>;
	/** On-disk format version. */
	version: typeof BUILD_MANIFEST_VERSION;
}

/** The verified Build Manifest, or the first reason to refuse it. */
export type ReadBuildManifestResult =
	| { actual: string; expected: string; kind: "buildid-mismatch" }
	| { actual: string; expected: string; kind: "clean-place-hash-mismatch"; path: string }
	| { actual: string; expected: string; kind: "coverage-place-hash-mismatch"; path: string }
	| { actual: string; expected: string; kind: "source-drift"; path: string }
	| { actual: unknown; expected: number; kind: "version-mismatch" }
	| { kind: "invalid"; summary: string }
	| { kind: "malformed-json" }
	| { kind: "missing" }
	| { kind: "missing-referenced-artifact"; path: string }
	| { kind: "ok"; manifest: BuildManifest };

/** Inputs to {@link emitBuildManifest}. */
export interface EmitBuildManifestOptions {
	/** Build record of the coverage run. */
	artifacts: Except<CoverageArtifacts, "rebuilt">;
	/** The uninstrumented place, when the caller built one. */
	cleanPlace?: BuildManifestArtifact;
	/** Destination of the manifest file. */
	filePath: string;
	/** Filesystem the manifest is written to. */
	fileSystem: FileSystem;
}

/** Extra checks {@link readBuildManifest} applies. */
export interface ReadBuildManifestOptions {
	/** When set, refuse if the manifest's `buildId` differs from this value. */
	expectedBuildId?: string;
	/** Where the artifacts are re-hashed. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
	/** Base for resolving place paths and `files` keys when re-hashing. */
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

const artifactSchema = type({
	"contentId?": "string",
	"hash": "string",
	"path": "string",
}).as<BuildManifestArtifact>();

export const buildManifestSchema: type<BuildManifest> = type({
	"buildId": "string",
	"cleanPlace?": artifactSchema,
	"coveragePlace": artifactSchema,
	"files": type({ "[string]": fileRecordSchema }),
	"generatedAt": "string",
	"projects": projectSchema.array(),
	"version": type.unit(BUILD_MANIFEST_VERSION),
}).as<BuildManifest>();

/** The build record of a coverage run. */
export interface CoverageArtifacts {
	/** UUID shared with the sibling Coverage Manifest. */
	buildId: string;
	/** The coverage-instrumented place. */
	coveragePlace: BuildManifestArtifact;
	/** Source hash of each compiled `.luau`, keyed by package-relative path. */
	files: Record<string, BuildManifestFileRecord>;
	/** ISO timestamp of the build. */
	generatedAt: string;
	/** Jest projects the place carries. */
	projects: Array<BuildManifestProject>;
	/** `false` on the incremental no-change reuse path. */
	rebuilt: boolean;
}

type VerifyResult = { actual: string; kind: "mismatch" } | { kind: "missing" } | { kind: "ok" };

/**
 * Projects coverage file records down to their source hashes.
 * @param files - Per-file coverage records keyed by package-relative path.
 * @returns The same keys mapped to their source hash only.
 */
export function toBuildManifestFiles(
	files: Record<string, { sourceHash: string }>,
): Record<string, BuildManifestFileRecord> {
	return Object.fromEntries(
		Object.entries(files).map(([key, record]) => [key, { sourceHash: record.sourceHash }]),
	);
}

/**
 * Writes the Build Manifest for a coverage run.
 * @param options - Build record, optional clean place and destination.
 */
export function emitBuildManifest({
	artifacts,
	cleanPlace,
	filePath,
	fileSystem,
}: EmitBuildManifestOptions): void {
	let manifest: BuildManifest = {
		buildId: artifacts.buildId,
		coveragePlace: artifacts.coveragePlace,
		files: artifacts.files,
		generatedAt: artifacts.generatedAt,
		projects: artifacts.projects,
		version: BUILD_MANIFEST_VERSION,
	};
	if (cleanPlace !== undefined) {
		manifest = { ...manifest, cleanPlace };
	}

	writeBuildManifest({ filePath, fileSystem, manifest });
}

/**
 * Reads a Build Manifest and re-hashes every file it records.
 * @param filePath - Where the manifest JSON is read from.
 * @param options - Expected build id, filesystem and resolution root.
 * @returns The verified manifest, or the first reason to refuse it.
 */
export function readBuildManifest(
	filePath: string,
	{
		expectedBuildId,
		fileSystem = nodeFileSystem,
		rootDir: rootDirectory,
	}: ReadBuildManifestOptions = {},
): ReadBuildManifestResult {
	const parsed = parseVersionedManifest({
		expectedVersion: BUILD_MANIFEST_VERSION,
		filePath,
		fileSystem,
		schema: buildManifestSchema,
	});
	if (parsed.kind !== "ok") {
		return parsed;
	}

	const { manifest } = parsed;

	if (expectedBuildId !== undefined && manifest.buildId !== expectedBuildId) {
		return { actual: manifest.buildId, expected: expectedBuildId, kind: "buildid-mismatch" };
	}

	const placeRefusal = verifyPlaces({ fileSystem, manifest, rootDirectory });
	if (placeRefusal !== undefined) {
		return placeRefusal;
	}

	const sourceRefusal = verifySourceFiles({ fileSystem, manifest, rootDirectory });
	if (sourceRefusal !== undefined) {
		return sourceRefusal;
	}

	return { kind: "ok", manifest };
}

function writeBuildManifest({
	filePath,
	fileSystem,
	manifest,
}: {
	filePath: string;
	fileSystem: FileSystem;
	manifest: BuildManifest;
}): void {
	atomicWrite({
		contents: JSON.stringify(manifest, undefined, "\t"),
		fileSystem,
		targetPath: filePath,
	});
}

function verifyArtifact({
	expectedHash,
	fileSystem,
	rootDirectory,
	storedPath,
}: {
	expectedHash: string;
	fileSystem: FileSystem;
	rootDirectory: string | undefined;
	storedPath: string;
}): VerifyResult {
	const diskPath =
		rootDirectory === undefined ? storedPath : path.join(rootDirectory, storedPath);
	if (!fileSystem.existsSync(diskPath)) {
		return { kind: "missing" };
	}

	const actual = hashFile(diskPath, fileSystem);
	if (actual !== expectedHash) {
		return { actual, kind: "mismatch" };
	}

	return { kind: "ok" };
}

function verifyPlace({
	artifact,
	fileSystem,
	mismatchKind,
	rootDirectory,
}: {
	artifact: BuildManifestArtifact;
	fileSystem: FileSystem;
	mismatchKind: "clean-place-hash-mismatch" | "coverage-place-hash-mismatch";
	rootDirectory: string | undefined;
}): ReadBuildManifestResult | undefined {
	const result = verifyArtifact({
		expectedHash: artifact.hash,
		fileSystem,
		rootDirectory,
		storedPath: artifact.path,
	});
	if (result.kind === "missing") {
		return { kind: "missing-referenced-artifact", path: artifact.path };
	}

	if (result.kind === "mismatch") {
		return {
			actual: result.actual,
			expected: artifact.hash,
			kind: mismatchKind,
			path: artifact.path,
		};
	}

	return undefined;
}

function verifyPlaces({
	fileSystem,
	manifest,
	rootDirectory,
}: {
	fileSystem: FileSystem;
	manifest: BuildManifest;
	rootDirectory: string | undefined;
}): ReadBuildManifestResult | undefined {
	const coverageRefusal = verifyPlace({
		artifact: manifest.coveragePlace,
		fileSystem,
		mismatchKind: "coverage-place-hash-mismatch",
		rootDirectory,
	});
	if (coverageRefusal !== undefined) {
		return coverageRefusal;
	}

	if (manifest.cleanPlace === undefined) {
		return undefined;
	}

	return verifyPlace({
		artifact: manifest.cleanPlace,
		fileSystem,
		mismatchKind: "clean-place-hash-mismatch",
		rootDirectory,
	});
}

function verifySourceFiles({
	fileSystem,
	manifest,
	rootDirectory,
}: {
	fileSystem: FileSystem;
	manifest: BuildManifest;
	rootDirectory: string | undefined;
}): ReadBuildManifestResult | undefined {
	for (const [key, record] of Object.entries(manifest.files)) {
		const result = verifyArtifact({
			expectedHash: record.sourceHash,
			fileSystem,
			rootDirectory,
			storedPath: key,
		});
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

	return undefined;
}
