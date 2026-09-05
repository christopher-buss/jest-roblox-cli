import { type } from "arktype";

import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

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

/**
 * No stray sweep, unlike the package's other publishers. This runs once per
 * covered file into the shadow mirror the same loop is filling, so the sweep's
 * directory scan grows with that directory and repeats for every file in it —
 * tens of microseconds each, where its caller in `instrumenter.ts` already
 * declines to spend microseconds. A stray left here belongs to a tree the next
 * instrumentation run rebuilds.
 */
export function writeCoverageMap(
	filePath: string,
	map: CoverageMap,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	atomicWrite({
		contents: JSON.stringify(map, undefined, "\t"),
		fileSystem,
		sweepStrays: false,
		targetPath: filePath,
	});
}

/**
 * Discriminated result lets callers distinguish "file missing" (silent cache
 * miss, will be regenerated) from "file present but unreadable" (fatal — see
 * `CoverageMapMalformedError` in mapper.ts). Folding both into `undefined`
 * forces a second `existsSync` to recover the distinction, which races against
 * the read.
 */
export function readCoverageMap(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): ReadCoverageMapResult {
	let contents: string;
	try {
		contents = fileSystem.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return { kind: "missing" };
		}

		// Any other IO error (EACCES, EISDIR, etc.) is unexpected — propagate
		// rather than misreport it as missing.
		throw err;
	}

	let parsed: JSONValue;
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
