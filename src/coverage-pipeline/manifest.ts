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

export interface InstrumentedFileRecord {
	key: string;
	branchCount?: number;
	coverageMapPath: string;
	/**
	 * Per-statement attribution: maps a Luau statement id (the probe index,
	 * same key space as the coverage-map sidecar) to the ids of the tests that
	 * covered it. Populated after a coverage run by the per-test attribution
	 * harvester; absent on a freshly-instrumented manifest (no run yet).
	 */
	coveringTestIds?: Record<string, Array<string>>;
	functionCount?: number;
	instrumentedLuauPath: string;
	originalLuauPath: string;
	sourceHash: string;
	sourceMapPath: string;
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

export interface TestLocation {
	column: number;
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

export interface NonInstrumentedFileRecord {
	shadowPath: string;
	sourceHash: string;
	sourcePath: string;
}

export interface CoverageManifest {
	/** Shared UUID linking this manifest to its sibling `BuildManifest`. */
	buildId: string;
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
	files: Record<string, InstrumentedFileRecord>;
	generatedAt: string;
	instrumenterVersion: number;
	luauRoots: Array<string>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFilePath?: string;
	/**
	 * SHA-256 over every rojo build input OUTSIDE the luauRoots
	 * (non-luauRoot `$path` mounts plus the rojo project files), per
	 * `computeRojoInputsHash`. The incremental cache rebuilds the place when
	 * it drifts. Absent on manifests written before this field existed; a
	 * missing value is treated as changed so the next run repopulates it.
	 */
	rojoInputsHash?: string;
	shadowDir: string;
	/**
	 * Per-test attribution records, one per Jest test case that covered at
	 * least one statement. Populated by the harvester after a coverage run;
	 * absent on a freshly-instrumented manifest.
	 */
	tests?: Array<TestRecord>;
	version: typeof MANIFEST_VERSION;
}

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

export function writeManifest(
	filePath: string,
	manifest: CoverageManifest,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	atomicWrite({
		contents: JSON.stringify(manifest, undefined, "\t"),
		fileSystem,
		targetPath: filePath,
	});
}

export function readManifest(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): ReadManifestResult {
	return parseVersionedManifest(filePath, manifestSchema, MANIFEST_VERSION, fileSystem);
}
