import type {
	MappedCoverageResult,
	MappedFileCoverage,
	PendingCoverage,
} from "#src/coverage-report/mapper-types.ts";

export function emptyPending(): PendingCoverage {
	return { branches: new Map(), functions: new Map(), statements: new Map() };
}

export function pendingResult(pending: PendingCoverage): MappedCoverageResult {
	const paths = new Set([
		...pending.statements.keys(),
		...pending.functions.keys(),
		...pending.branches.keys(),
	]);
	return {
		files: Object.fromEntries(
			Array.from(paths, (filePath) => [filePath, numberFile(pending, filePath)]),
		),
	};
}

function numberStatements(
	file: MappedFileCoverage,
	pending: PendingCoverage,
	filePath: string,
): void {
	const statements = [...(pending.statements.get(filePath)?.values() ?? [])].flat();
	for (const [index, statement] of statements.entries()) {
		file.statementMap[String(index)] = { end: statement.end, start: statement.start };
		file.s[String(index)] = statement.hitCount;
	}
}

function numberFile(pending: PendingCoverage, filePath: string): MappedFileCoverage {
	const file: MappedFileCoverage = {
		b: {},
		branchMap: {},
		f: {},
		fnMap: {},
		path: filePath,
		s: {},
		statementMap: {},
	};

	numberStatements(file, pending, filePath);

	const functions = pending.functions.get(filePath) ?? [];
	for (const [index, func] of functions.entries()) {
		file.fnMap[String(index)] = { name: func.name, loc: func.loc };
		file.f[String(index)] = func.hitCount;
	}

	const branches = pending.branches.get(filePath) ?? [];
	for (const [index, branch] of branches.entries()) {
		file.branchMap[String(index)] = {
			loc: branch.loc,
			locations: branch.locations,
			type: branch.type,
		};
		file.b[String(index)] = branch.armHitCounts;
	}

	return file;
}
