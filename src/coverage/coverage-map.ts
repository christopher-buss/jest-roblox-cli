import { type } from "arktype";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { isErrnoException } from "../utils/errno.ts";

export interface SourceLocation {
	end: { column: number; line: number };
	start: { column: number; line: number };
}

export interface CoverageMap {
	branchMap?: Record<string, { locations: Array<SourceLocation>; type: string }>;
	functionMap?: Record<string, { location: SourceLocation; name: string }>;
	statementMap: Record<string, SourceLocation>;
}

export type ReadCoverageMapResult =
	| { kind: "invalid" }
	| { kind: "missing" }
	| { kind: "ok"; map: CoverageMap };

const positionSchema = type({ column: "number", line: "number" });
const spanSchema = type({ end: positionSchema, start: positionSchema });
const functionEntrySchema = type({ name: "string", location: spanSchema });
const branchEntrySchema = type({ locations: spanSchema.array(), type: "string" });

const coverageMapSchema = type({
	"branchMap?": type({ "[string]": branchEntrySchema }),
	"functionMap?": type({ "[string]": functionEntrySchema }),
	"statementMap": type({ "[string]": spanSchema }),
}).as<CoverageMap>();

export function writeCoverageMap(filePath: string, map: CoverageMap): void {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const temporaryPath = path.join(directory, `${path.basename(filePath)}.tmp.${process.pid}`);
	fs.writeFileSync(temporaryPath, JSON.stringify(map, undefined, "\t"));
	fs.renameSync(temporaryPath, filePath);
}

/**
 * Discriminated result lets callers distinguish "file missing" (silent cache
 * miss, will be regenerated) from "file present but unreadable" (fatal — see
 * `CoverageMapMalformedError` in mapper.ts). Folding both into `undefined`
 * forces a second `existsSync` to recover the distinction, which races against
 * the read.
 */
export function readCoverageMap(filePath: string): ReadCoverageMapResult {
	let contents: string;
	try {
		contents = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { kind: "missing" };
		}

		// Any other IO error (EACCES, EISDIR, etc.) is unexpected — propagate
		// rather than misreport it as missing.
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return { kind: "invalid" };
	}

	const validated = coverageMapSchema(parsed);
	if (validated instanceof type.errors) {
		return { kind: "invalid" };
	}

	return { kind: "ok", map: validated };
}
