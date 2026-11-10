import { type } from "arktype";

import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ParsedManifest } from "./manifest-parse.ts";
import { parseVersionedManifest } from "./manifest-parse.ts";

/** On-disk format version for `coverage-manifest.json`. */
export const MANIFEST_VERSION = 6 as const;

/** One instrumented Luau file in the coverage manifest. */
export interface InstrumentedFileRecord {
	/** Join key the runtime hit table and coverage map share. */
	key: string;
	/** Number of branches probed. */
	branchCount?: number;
	/** Path of the coverage-map sidecar. */
	coverageMapPath: string;
	/** Ids of the tests that covered each statement id. */
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
	/** Statement ids hit but credited to no test. */
	staticStatementIds?: Array<string>;
}

/** Where a test is declared. */
export interface TestLocation {
	/** Column of the declaration. */
	column: number;
	/** Line of the declaration. */
	line: number;
}

/** One Jest test case's identity. */
export interface TestRecord {
	/** Where the test is declared, in the file `testFileSourceHash` hashes. */
	location?: TestLocation;
	/** Full test name (describe chain + leaf `it`). */
	testCaseId: string;
	/** The test file's DataModel path, as the runner observed it. */
	testFilePath: string;
	/** SHA-256 of the test file's source, for cache invalidation. */
	testFileSourceHash: string;
	/** Stable unique id for the test case; referenced by `coveringTestIds`. */
	testId: string;
	/** SHA-256 of the test's own range of the file. */
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
	/** Digest of the `coverageCopyIgnorePatterns`. */
	copyIgnoreHash?: string | undefined;
	/** Digest of the instrument universe; absent when nothing was narrowed. */
	coverageUniverseHash?: string | undefined;
	/** Instrumented files by key. */
	files: Record<string, InstrumentedFileRecord>;
	/** ISO timestamp of the write. */
	generatedAt: string;
	/** Probe-output version; a mismatch invalidates the cache. */
	instrumenterVersion: number;
	/** The roots this shadow instruments. */
	luauRoots: Array<string>;
	/** Mirrored, unprobed files by source path. */
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	/** Path of the built coverage place. */
	placeFilePath?: string;
	/** SHA-256 over every rojo build input outside the `luauRoots`. */
	rojoInputsHash?: string | undefined;
	/** The shadow directory the manifest describes. */
	shadowDir: string;
	/** One record per test case that covered a statement. */
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
 * Writes a coverage manifest atomically.
 * @param options - Target path, file system and manifest.
 */
export function writeManifest({
	filePath,
	fileSystem,
	manifest,
}: {
	/** Where the manifest is written. */
	filePath: string;
	/** File system to write through. */
	fileSystem: FileSystem;
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
 * Reads and validates a coverage manifest.
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
