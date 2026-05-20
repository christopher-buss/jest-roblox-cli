import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

/**
 * On-disk format version for `manifest.json`. Bump when the schema below
 * changes shape; `INSTRUMENTER_VERSION` is independent and tracks probe-output
 * compatibility (cache invalidation), not file format.
 *
 * The in-process `CollectorResult` contract between coverage-collector and
 * probe-inserter is intentionally not formalized here: it has no serialization
 * boundary, so the TypeScript interface is sufficient.
 */
export const MANIFEST_VERSION = 2 as const;

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
	files: Record<string, InstrumentedFileRecord>;
	generatedAt: string;
	instrumenterVersion: number;
	luauRoots: Array<string>;
	nonInstrumentedFiles: Record<string, NonInstrumentedFileRecord>;
	placeFilePath?: string;
	shadowDir: string;
	version: typeof MANIFEST_VERSION;
}

export type ReadManifestResult =
	| { actual: unknown; expected: number; kind: "version-mismatch" }
	| { kind: "invalid"; summary: string }
	| { kind: "malformed-json" }
	| { kind: "missing" }
	| { kind: "ok"; manifest: CoverageManifest };

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
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const temporaryPath = path.join(directory, `${path.basename(filePath)}.tmp.${process.pid}`);
	fs.writeFileSync(temporaryPath, JSON.stringify(manifest, undefined, "\t"));
	fs.renameSync(temporaryPath, filePath);
}

export function readManifest(filePath: string): ReadManifestResult {
	let contents: string;
	try {
		contents = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { kind: "missing" };
		}

		// Any other IO error (EACCES, EISDIR, etc.) is unexpected — propagate
		// rather than misreport it as malformed JSON.
		throw err;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(contents);
	} catch {
		return { kind: "malformed-json" };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { kind: "invalid", summary: "manifest must be a JSON object" };
	}

	// Only a numeric version that doesn't match counts as a version mismatch;
	// missing or non-numeric version is a generic schema error so callers can
	// distinguish "this is a v2 manifest" from "this isn't a manifest at all".
	const peeked = (raw as { version?: unknown }).version;
	if (typeof peeked === "number" && peeked !== MANIFEST_VERSION) {
		return { actual: peeked, expected: MANIFEST_VERSION, kind: "version-mismatch" };
	}

	const parsed = manifestSchema(raw);
	if (parsed instanceof type.errors) {
		return { kind: "invalid", summary: parsed.summary };
	}

	return { kind: "ok", manifest: parsed };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return (
		err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string"
	);
}
