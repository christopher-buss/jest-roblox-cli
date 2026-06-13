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

/** Filename the Build Manifest is published under, next to its Coverage Manifest. */
export const BUILD_MANIFEST_FILE = "build-manifest.json";

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
	/**
	 * The uninstrumented place a consumer mutates and runs against. Present only
	 * when produced by `prepareArtifacts`; `runJestRoblox` / the CLI never build
	 * one, so coverage-only manifests omit it.
	 */
	cleanPlace?: BuildManifestArtifact;
	/** The coverage-instrumented place — the only source of coverage hit data. */
	coveragePlace: BuildManifestArtifact;
	/** SHA-256 of each compiled `.luau`, keyed by package-relative POSIX path. */
	files: Record<string, BuildManifestFileRecord>;
	generatedAt: string;
	projects: Array<BuildManifestProject>;
	version: typeof BUILD_MANIFEST_VERSION;
}

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

export interface ReadBuildManifestOptions {
	/** When set, refuse if the manifest's `buildId` differs from this value. */
	expectedBuildId?: string;
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

const artifactSchema = type({ hash: "string", path: "string" }).as<BuildManifestArtifact>();

export const buildManifestSchema: type<BuildManifest> = type({
	"buildId": "string",
	"cleanPlace?": artifactSchema,
	"coveragePlace": artifactSchema,
	"files": type({ "[string]": fileRecordSchema }),
	"generatedAt": "string",
	"projects": projectSchema.array(),
	"version": type.unit(BUILD_MANIFEST_VERSION),
}).as<BuildManifest>();

/**
 * The producer-side build record an entry point emits after a coverage run.
 * `prepareCoverage` returns this so `runJestRoblox` and `prepareArtifacts` can
 * each write the Build Manifest with the place set they actually have.
 */
export interface CoverageArtifacts {
	buildId: string;
	coveragePlace: BuildManifestArtifact;
	files: Record<string, BuildManifestFileRecord>;
	generatedAt: string;
	/**
	 * Per-project DataModel paths the kernel consumes, resolved by the run path
	 * that built the place. Empty when the run resolved no projects.
	 */
	projects: Array<BuildManifestProject>;
	/** `false` on the incremental no-change reuse path. */
	rebuilt: boolean;
}

type VerifyResult = { actual: string; kind: "mismatch" } | { kind: "missing" } | { kind: "ok" };

export function writeBuildManifest(filePath: string, manifest: BuildManifest): void {
	atomicWrite(filePath, JSON.stringify(manifest, undefined, "\t"));
}

/**
 * Project a coverage file map down to the Build Manifest's `{ sourceHash }`
 * records, dropping the instrumentation metadata only the coverage pipeline
 * needs. The input is structural so both the single/multi and workspace coverage
 * paths can feed their richer per-file records.
 */
export function toBuildManifestFiles(
	files: Record<string, { sourceHash: string }>,
): Record<string, BuildManifestFileRecord> {
	return Object.fromEntries(
		Object.entries(files).map(([key, record]) => [key, { sourceHash: record.sourceHash }]),
	);
}

/**
 * Emit the Build Manifest for a coverage run in a single atomic write. The
 * `coveragePlace` is always recorded; `cleanPlace` is added only when the caller
 * (`prepareArtifacts`) actually built one — so the producer can never record a
 * place it didn't build.
 */
export function emitBuildManifest(
	filePath: string,
	artifacts: CoverageArtifacts,
	cleanPlace?: BuildManifestArtifact,
): void {
	writeBuildManifest(filePath, {
		buildId: artifacts.buildId,
		...(cleanPlace !== undefined ? { cleanPlace } : {}),
		coveragePlace: artifacts.coveragePlace,
		files: artifacts.files,
		generatedAt: artifacts.generatedAt,
		projects: artifacts.projects,
		version: BUILD_MANIFEST_VERSION,
	});
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

	// The coverage place is always present and is checked first: a drifted
	// instrumented place poisons the coverage hit data every consumer relies on.
	const coverageRefusal = verifyPlace(
		manifest.coveragePlace,
		"coverage-place-hash-mismatch",
		rootDirectory,
	);
	if (coverageRefusal !== undefined) {
		return coverageRefusal;
	}

	// The clean place is optional (only `prepareArtifacts` emits it); re-hash it
	// only when present.
	if (manifest.cleanPlace !== undefined) {
		const cleanRefusal = verifyPlace(
			manifest.cleanPlace,
			"clean-place-hash-mismatch",
			rootDirectory,
		);
		if (cleanRefusal !== undefined) {
			return cleanRefusal;
		}
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

/**
 * Re-hash one place artifact, mapping a missing file or hash drift to the
 * matching refuse variant. Returns `undefined` when the place is intact.
 */
function verifyPlace(
	artifact: BuildManifestArtifact,
	mismatchKind: "clean-place-hash-mismatch" | "coverage-place-hash-mismatch",
	rootDirectory: string | undefined,
): ReadBuildManifestResult | undefined {
	const result = verifyArtifact(artifact.path, artifact.hash, rootDirectory);
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
