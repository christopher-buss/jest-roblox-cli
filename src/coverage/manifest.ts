import { type } from "arktype";

import { atomicWrite } from "../utils/atomic-write.ts";
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
export const MANIFEST_VERSION = 3 as const;

export interface InstrumentedFileRecord {
	key: string;
	branchCount?: number;
	coverageMapPath: string;
	functionCount?: number;
	instrumentedLuauPath: string;
	originalLuauPath: string;
	sourceHash: string;
	sourceMapPath: string;
	statementCount: number;
}

export interface NonInstrumentedFileRecord {
	shadowPath: string;
	sourceHash: string;
	sourcePath: string;
}

export interface CoverageManifest {
	/** Shared UUID linking this manifest to its sibling `BuildManifest`. */
	buildId: string;
	files: Record<string, InstrumentedFileRecord>;
	generatedAt: string;
	instrumenterVersion: number;
	luauRoots: Array<string>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFilePath?: string;
	shadowDir: string;
	version: typeof MANIFEST_VERSION;
}

export type ReadManifestResult = ParsedManifest<CoverageManifest>;

const instrumentedFileRecordSchema = type({
	"key": "string",
	"branchCount?": "number",
	"coverageMapPath": "string",
	"functionCount?": "number",
	"instrumentedLuauPath": "string",
	"originalLuauPath": "string",
	"sourceHash": "string",
	"sourceMapPath": "string",
	"statementCount": "number",
}).as<InstrumentedFileRecord>();

const nonInstrumentedRecordSchema = type({
	shadowPath: "string",
	sourceHash: "string",
	sourcePath: "string",
}).as<NonInstrumentedFileRecord>();

export const manifestSchema: type<CoverageManifest> = type({
	"buildId": "string",
	"files": type({ "[string]": instrumentedFileRecordSchema }),
	"generatedAt": "string",
	"instrumenterVersion": "number",
	"luauRoots": "string[]",
	"nonInstrumentedFiles": type({ "[string]": nonInstrumentedRecordSchema }),
	"placeFilePath?": "string",
	"shadowDir": "string",
	"version": type.unit(MANIFEST_VERSION),
}).as<CoverageManifest>();

export function writeManifest(filePath: string, manifest: CoverageManifest): void {
	atomicWrite(filePath, JSON.stringify(manifest, undefined, "\t"));
}

export function readManifest(filePath: string): ReadManifestResult {
	return parseVersionedManifest(filePath, manifestSchema, MANIFEST_VERSION);
}
