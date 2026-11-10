import type { CoverageMap } from "../coverage-data/coverage-map.ts";

/** Istanbul-shaped coverage for one source file. */
export interface MappedFileCoverage {
	/** Per-arm hit counts, keyed by branch id. */
	b: Record<string, Array<number>>;
	/** Branch spans and arm locations, keyed by branch id. */
	branchMap: Record<
		string,
		{
			/** Span from the first arm's start to the last arm's end. */
			loc: MappedSpan;
			/** One span per arm, in arm order. */
			locations: Array<MappedSpan>;
			/** Istanbul branch kind. */
			type: string;
		}
	>;
	/** Hit counts, keyed by function id. */
	f: Record<string, number>;
	/** Function names and spans, keyed by function id. */
	fnMap: Record<
		string,
		{
			/** Span of the function. */
			loc: MappedSpan;
			/** Function name as reported. */
			name: string;
		}
	>;
	/** Source file path the coverage belongs to. */
	path: string;
	/** Hit counts, keyed by statement id. */
	s: Record<string, number>;
	/** Statement spans, keyed by statement id. */
	statementMap: Record<string, MappedSpan>;
}

/** Mapped coverage for every source file. */
export interface MappedCoverageResult {
	/** Per-file coverage, keyed by source path. */
	files: Record<string, MappedFileCoverage>;
}

/** Maps a generated position back to its original source position. */
export type PositionResolver = (position: GeneratedPosition) => OriginalPosition;

/** A statement awaiting coalescing into the mapped result. */
export interface PendingStatement {
	/** Where the statement ends. */
	end: MappedPosition;
	/** Times the statement ran. */
	hitCount: number;
	/** Where the statement starts. */
	start: MappedPosition;
}

/** One source file's statements, grouped by start line. */
export type FileStatements = Map<number, Array<PendingStatement>>;

/** A function awaiting conversion into the mapped result. */
export interface PendingFunction {
	/** Function name as reported. */
	name: string;
	/** Times the function ran. */
	hitCount: number;
	/** Span of the function. */
	loc: MappedSpan;
}

/** A branch awaiting conversion into the mapped result. */
export interface PendingBranch {
	/** Times each arm ran, in arm order. */
	armHitCounts: Array<number>;
	/** Span from the first arm's start to the last arm's end. */
	loc: MappedSpan;
	/** One span per arm, in arm order. */
	locations: Array<MappedSpan>;
	/** Istanbul branch kind. */
	type: string;
}

/** Coverage accumulated per source path before it is emitted. */
export interface PendingCoverage {
	/** Branches per source path. */
	branches: Map<string, Array<PendingBranch>>;
	/** Functions per source path. */
	functions: Map<string, Array<PendingFunction>>;
	/** Statements per source path. */
	statements: Map<string, FileStatements>;
}

/** Inputs loaded for mapping one instrumented file. */
export interface FileResources {
	/** The file's probe-to-span coverage map. */
	coverageMap: CoverageMap;
	/**
	 * Source-map lookup, or `undefined` for a native Luau file mapped as-is.
	 */
	resolvePosition: PositionResolver | undefined;
	/** Key under which the file's pending coverage accumulates. */
	sourceKey: string;
	/** Directory that relative source-map sources resolve against. */
	sourceMapDirectory: string;
}

/** File resources narrowed to a file that has a source map. */
export interface SourceMapped {
	/** The file's probe-to-span coverage map. */
	coverageMap: CoverageMap;
	/** Source-map lookup. */
	resolvePosition: PositionResolver;
	/** Directory that relative source-map sources resolve against. */
	sourceMapDirectory: string;
}

interface MappedPosition {
	column: number;
	line: number;
}

interface MappedSpan {
	end: MappedPosition;
	start: MappedPosition;
}

type OriginalPosition =
	| { column: null; line: null; source: null }
	| { column: number; line: number; source: null | string };

interface GeneratedPosition {
	column: number;
	line: number;
}
