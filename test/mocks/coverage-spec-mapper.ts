export interface FileLocation {
	end: { column: number; line: number };
	start: { column: number; line: number };
}

export interface CoverageMapFile {
	branchMap?: Record<string, { locations: Array<FileLocation>; type: string }>;
	functionMap?: Record<string, { location: FileLocation; name: string }>;
	statementMap: Record<string, FileLocation>;
}

export function createCoverageMap(
	statementMap: CoverageMapFile["statementMap"] = {},
	{
		branchMap,
		functionMap,
	}: {
		branchMap?: CoverageMapFile["branchMap"] | undefined;
		functionMap?: CoverageMapFile["functionMap"] | undefined;
	} = {},
): CoverageMapFile {
	let coverageMap: CoverageMapFile = { statementMap };
	if (functionMap !== undefined) {
		coverageMap = { ...coverageMap, functionMap };
	}

	if (branchMap !== undefined) {
		coverageMap = { ...coverageMap, branchMap };
	}

	return coverageMap;
}

export function span(line: number, startColumn: number, endColumn: number): FileLocation {
	return { end: { column: endColumn, line }, start: { column: startColumn, line } };
}
