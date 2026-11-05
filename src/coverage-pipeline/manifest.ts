import { type } from "arktype";

import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ParsedManifest } from "./manifest-parse.ts";
import { parseVersionedManifest } from "./manifest-parse.ts";

/**
 * On-disk format version for `coverage-manifest.json`. Bump when the schema
 * below changes shape; `INSTRUMENTER_VERSION` is independent and tracks
 * probe-output compatibility (cache invalidation), not file format.
 *
 * The in-process `CollectorResult` contract between coverage-collector and
 * probe-inserter is intentionally not formalized here: it has no serialization
 * boundary, so the TypeScript interface is sufficient.
 */
export const MANIFEST_VERSION = 5 as const;

/** One instrumented Luau file in the coverage manifest. */
export interface InstrumentedFileRecord {
	/** Join key the runtime hit table and coverage map share. */
	key: string;
	/** Number of branches probed. */
	branchCount?: number;
	/** Path of the coverage-map sidecar. */
	coverageMapPath: string;
	/**
	 * Per-statement attribution: maps a Luau statement id (the probe index,
	 * same key space as the coverage-map sidecar) to the ids of the tests that
	 * covered it. Populated after a coverage run by the per-test attribution
	 * harvester; absent on a freshly-instrumented manifest (no run yet).
	 */
	coveringTestIds?: Record<string, Array<string>>;
	/** Number of functions probed. */
	functionCount?: number;
	/** Path of the probed twin in the shadow. */
	instrumentedLuauPath: string;
	/** Path of the compiled Luau file the twin was made from. */
	originalLuauPath: string;
	/** Hash of the original's bytes, for incremental reuse. */
	sourceHash: string;
	/** Path of the original's source map, which also describes the twin. */
	sourceMapPath: string;
	/** Number of statements probed. */
	statementCount: number;
	/**
	 * Statement ids hit during the coverage run but credited to no per-test
	 * window (executed at module load or in a hook). Computed by the
	 * per-test attribution harvester; a consumer marks a mutant on one of
	 * these as Ignored (ADR-0003). Absent on a freshly-instrumented
	 * manifest (no run yet).
	 */
	staticStatementIds?: Array<string>;
}

/** Where a test is declared. */
export interface TestLocation {
	/** Column of the declaration. */
	column: number;
	/** Line of the declaration. */
	line: number;
}

/**
 * One Jest test case's identity, recorded so Phase 3's differential cache can
 * key on which tests cover a mutant and whether their source changed.
 * `coveringTestIds` references these by `testId`.
 */
export interface TestRecord {
	/**
	 * Where the test is declared, in the coordinates of the file
	 * `testFileSourceHash` hashes: the TypeScript line when the test file has a
	 * source map, the Luau line otherwise. The column is always 0, as Luau
	 * frames carry none. Absent when the runtime could not read the call site.
	 */
	location?: TestLocation;
	/** Full test name (describe chain + leaf `it`). */
	testCaseId: string;
	/** The test file's DataModel path, as the runner observed it. */
	testFilePath: string;
	/** SHA-256 of the test file's source, for cache invalidation. */
	testFileSourceHash: string;
	/** Stable unique id for the test case; referenced by `coveringTestIds`. */
	testId: string;
	/**
	 * SHA-256 of the test's own range of the file: from `location` to the next
	 * test's start, or to end of file. Lets a consumer see a spec edit that
	 * left this test alone. Present exactly when `location` is.
	 */
	testSourceHash?: string;
}

/** A file the shadow mirrors without probes. */
export interface NonInstrumentedFileRecord {
	/** Path of the copy in the shadow. */
	shadowPath: string;
	/** Hash of the source bytes, for incremental reuse. */
	sourceHash: string;
	/** Path of the source file. */
	sourcePath: string;
}

/** Contents of `coverage-manifest.json`. */
export interface CoverageManifest {
	/** Shared UUID linking this manifest to its sibling `BuildManifest`. */
	buildId: string;
	/**
	 * What the Code Mount split would emit for the place beside this manifest:
	 * its pass version and the Code Roots it ran over, or absent for a place
	 * built whole. The incremental cache rebuilds on a mismatch, which is what
	 * keeps a harness built by an older split rule — or by a run that shipped
	 * its code differently — from being handed out as current. Absent on
	 * manifests written before this field existed, which reads as a whole-place
	 * build and so rebuilds for the first harness run.
	 */
	codeSplitKey?: string | undefined;
	/**
	 * Digest of the `coverageCopyIgnorePatterns` that decided what this shadow
	 * carries, per `hashCopyIgnorePatterns`. The incremental cache rebuilds on
	 * a mismatch: a widened list demotes a file the shadow already holds while
	 * its source hash stays put, exactly as a narrowed universe does. Absent on
	 * manifests written before this field existed, which reads as changed and
	 * repopulates it on the next run.
	 */
	copyIgnoreHash?: string | undefined;
	/**
	 * Digest of the `collectCoverageFrom` / `coveragePathIgnorePatterns` pair
	 * that decided which files were instrumented, per
	 * `createInstrumentUniverse`. Absent when the config narrowed nothing, so
	 * the whole root was instrumented. The incremental cache rebuilds on a
	 * mismatch: narrowing the globs leaves already-probed copies in the shadow
	 * that no source hash would invalidate.
	 */
	coverageUniverseHash?: string | undefined;
	/** Instrumented files by key. */
	files: Record<string, InstrumentedFileRecord>;
	/** ISO timestamp of the write. */
	generatedAt: string;
	/** Probe-output version; a mismatch invalidates the cache. */
	instrumenterVersion: number;
	/** The luau roots this shadow instruments. */
	luauRoots: Array<string>;
	/** Mirrored, unprobed files by source path. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	/** Path of the built coverage place. */
	placeFilePath?: string;
	/**
	 * SHA-256 over every rojo build input OUTSIDE the luauRoots
	 * (non-luauRoot `$path` mounts plus the rojo project files), per
	 * `computeRojoInputsHash`. The incremental cache rebuilds the place when
	 * it drifts. Absent on manifests written before this field existed; a
	 * missing value is treated as changed so the next run repopulates it.
	 */
	rojoInputsHash?: string | undefined;
	/** The shadow directory the manifest describes. */
	shadowDir: string;
	/**
	 * Per-test attribution records, one per Jest test case that covered at
	 * least one statement. Populated by the harvester after a coverage run;
	 * absent on a freshly-instrumented manifest.
	 */
	tests?: Array<TestRecord>;
	/** On-disk format version. */
	version: typeof MANIFEST_VERSION;
}

/** Outcome of reading a coverage manifest. */
export type ReadManifestResult = ParsedManifest<CoverageManifest>;

const instrumentedFileRecordSchema = type({
	"key": "string",
	"branchCount?": "number",
	"coverageMapPath": "string",
	"coveringTestIds?": type({ "[string]": "string[]" }),
	"functionCount?": "number",
	"instrumentedLuauPath": "string",
	"originalLuauPath": "string",
	"sourceHash": "string",
	"sourceMapPath": "string",
	"statementCount": "number",
	"staticStatementIds?": "string[]",
}).as<InstrumentedFileRecord>();

const testRecordSchema = type({
	"location?": type({ column: "number", line: "number" }),
	"testCaseId": "string",
	"testFilePath": "string",
	"testFileSourceHash": "string",
	"testId": "string",
	"testSourceHash?": "string",
}).as<TestRecord>();

const nonInstrumentedRecordSchema = type({
	shadowPath: "string",
	sourceHash: "string",
	sourcePath: "string",
}).as<NonInstrumentedFileRecord>();

export const manifestSchema: type<CoverageManifest> = type({
	"buildId": "string",
	"codeSplitKey?": "string",
	"copyIgnoreHash?": "string",
	"coverageUniverseHash?": "string",
	"files": type({ "[string]": instrumentedFileRecordSchema }),
	"generatedAt": "string",
	"instrumenterVersion": "number",
	"luauRoots": "string[]",
	"nonInstrumentedFiles": type({ "[string]": nonInstrumentedRecordSchema }),
	"placeFilePath?": "string",
	"rojoInputsHash?": "string",
	"shadowDir": "string",
	"tests?": testRecordSchema.array(),
	"version": type.unit(MANIFEST_VERSION),
}).as<CoverageManifest>();

/**
 * Write a coverage manifest atomically as tab-indented JSON.
 * @param options - Target path, file system and manifest.
 */
export function writeManifest({
	filePath,
	fileSystem = nodeFileSystem,
	manifest,
}: {
	/** Where the manifest is written. */
	filePath: string;
	/** File system to write through. */
	fileSystem?: FileSystem;
	/** Manifest to write. */
	manifest: CoverageManifest;
}): void {
	atomicWrite({
		contents: JSON.stringify(manifest, undefined, "\t"),
		fileSystem,
		targetPath: filePath,
	});
}

/**
 * Read and validate a coverage manifest.
 * @param filePath - Where `coverage-manifest.json` is read from.
 * @param fileSystem - File system to read through.
 * @returns The manifest, or why it was refused.
 * @throws When reading fails for a reason other than a missing file.
 */
export function readManifest(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): ReadManifestResult {
	return parseVersionedManifest({
		expectedVersion: MANIFEST_VERSION,
		filePath,
		fileSystem,
		schema: manifestSchema,
	});
}
