/**
 * Source location within a file.
 */
export interface SourceLocation {
	end: { column: number; line: number };
	start: { column: number; line: number };
}

/**
 * Raw hit counts for a single file, keyed by statement/function index.
 */
export interface RawFileCoverage {
	b?: Record<string, Array<number>>;
	f?: Record<string, number>;
	s: Record<string, number>;
}

/**
 * Raw coverage data for all files, keyed by original Luau-relative path.
 */
export type RawCoverageData = Record<string, RawFileCoverage>;

/**
 * Coverage map sidecar for a single instrumented file.
 * Maps statement indices to source locations in the original Luau.
 */
export interface CoverageMap {
	branchMap?: Record<string, { locations: Array<SourceLocation>; type: string }>;
	functionMap?: Record<string, { location: SourceLocation; name: string }>;
	statementMap: Record<string, SourceLocation>;
}

/**
 * Metadata for a single instrumented file in the manifest.
 */
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

/**
 * Manifest emitted by `jest-roblox instrument`.
 */
export interface CoverageManifest {
	files: Record<string, InstrumentedFileRecord>;
	generatedAt: string;
	instrumenterVersion: number;
	luauRoots: Array<string>;
	placeFilePath?: string;
	shadowDir: string;
	version: 1;
}
