import type { Utf16Column } from "@isentinel/luau-ast/ast";

import { type } from "arktype";

import { atomicWrite } from "../utils/atomic-write.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { readUnlessMissing } from "./manifest-parse.ts";

/** A span in the source, with UTF-16 columns. */
export interface SourceLocation {
	/** Where the span ends. */
	end: {
		/** UTF-16 column of the end. */
		column: Utf16Column;
		/** Line of the end. */
		line: number;
	};
	/** Where the span starts. */
	start: {
		/** UTF-16 column of the start. */
		column: Utf16Column;
		/** Line of the start. */
		line: number;
	};
}

/** Istanbul-shaped locations of one file, keyed by counter index. */
export interface CoverageMap {
	/** Arm locations and branch type of each branch. */
	branchMap?: Record<
		string,
		{
			/** Span of each arm, in arm order. */
			locations: Array<SourceLocation>;
			/** Istanbul branch type. */
			type: string;
		}
	>;
	/** Span and name of each function. */
	functionMap?: Record<
		string,
		{
			/** Span of the function. */
			location: SourceLocation;
			/** Function name, or `(anonymous)`. */
			name: string;
		}
	>;
	/** Span of each statement. */
	statementMap: Record<string, SourceLocation>;
}

/** Outcome of reading a coverage map file. */
export type ReadCoverageMapResult =
	| {
			/** No file exists at the path. */
			kind: "missing";
	  }
	| {
			/** The file exists but is not a valid coverage map. */
			kind: "invalid";
	  }
	| {
			/** The file parsed. */
			kind: "ok";
			/** The parsed coverage map. */
			map: CoverageMap;
	  };

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
 * Writes a coverage map without a stray sweep.
 * @param options - Destination, filesystem and map.
 */
export function writeCoverageMap({
	filePath,
	fileSystem,
	map,
}: {
	/** Destination of the map file. */
	filePath: string;
	/** Filesystem to write to. */
	fileSystem: FileSystem;
	/** Map to serialize. */
	map: CoverageMap;
}): void {
	atomicWrite({
		contents: JSON.stringify(map, undefined, "\t"),
		fileSystem,
		sweepStrays: false,
		targetPath: filePath,
	});
}

/**
 * Reads a coverage map file.
 * @param filePath - Where the map JSON is read from.
 * @param fileSystem - Filesystem to read.
 * @returns The parsed map, or why it could not be read.
 * @throws When reading fails for a reason other than a missing file.
 */
export function readCoverageMap(filePath: string, fileSystem: FileSystem): ReadCoverageMapResult {
	const contents = readUnlessMissing(filePath, fileSystem);
	if (contents === undefined) {
		return { kind: "missing" };
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
