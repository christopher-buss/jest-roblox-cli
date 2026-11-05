import type { LuauSpan } from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import type {
	CollectorResult,
	CoverageAccumulator,
	SourcePosition,
	StatementBranchArm,
} from "../../src/coverage-pipeline/coverage-accumulator.ts";

type Result = CollectorResult<LuauSpan>;
type BranchArm = Result["branches"][number]["arms"][number];

interface FunctionEntry {
	name: string;
	location: LuauSpan;
	start: SourcePosition;
}

interface ImplicitElse {
	ifStart: SourcePosition;
	probeEnd: SourcePosition;
}

class RecordingAccumulator {
	private readonly recorded: Result = {
		branches: [],
		functions: [],
		implicitElseProbes: [],
		statements: [],
		wrapProbes: [],
	};

	private branchIndex = 1;
	private functionIndex = 1;
	private statementIndex = 1;

	public addExpressionBranch(branchType: string, armLocations: Array<LuauSpan>): void {
		const index = this.nextBranch();
		this.recorded.branches.push({
			arms: armLocations.map((location) => arm(0, 0, location)),
			branchType,
			index,
		});
		for (const [offset, location] of armLocations.entries()) {
			this.recorded.wrapProbes.push({
				armIndex: offset + 1,
				branchIndex: index,
				exprLocation: { ...location },
			});
		}
	}

	public addFunction({ name, location, start }: FunctionEntry): void {
		const index = this.functionIndex;
		this.functionIndex += 1;
		this.recorded.functions.push({
			name,
			bodyFirstColumn: start.column,
			bodyFirstLine: start.line,
			index,
			location: { ...location },
		});
	}

	public addStatement(location: LuauSpan): void {
		const index = this.statementIndex;
		this.statementIndex += 1;
		this.recorded.statements.push({ index, location: { ...location } });
	}

	public addStatementBranch(arms: Array<StatementBranchArm>, implicitElse?: ImplicitElse): void {
		const index = this.nextBranch();
		const branchArms = arms.map(({ bodyFirst, location }) => {
			return arm(bodyFirst.column, bodyFirst.line, location);
		});
		if (implicitElse !== undefined) {
			branchArms.push(arm(0, 0, pointSpan(implicitElse.ifStart)));
			this.recorded.implicitElseProbes.push({
				armIndex: branchArms.length,
				branchIndex: index,
				endColumn: implicitElse.probeEnd.column,
				endLine: implicitElse.probeEnd.line,
			});
		}

		this.recorded.branches.push({ arms: branchArms, branchType: "if", index });
	}

	public result(): Result {
		return this.recorded;
	}

	private nextBranch(): number {
		const index = this.branchIndex;
		this.branchIndex += 1;
		return index;
	}
}

export function recordingAccumulator(): CoverageAccumulator {
	return fromAny<CoverageAccumulator, RecordingAccumulator>(new RecordingAccumulator());
}

function arm(column: number, line: number, location: LuauSpan): BranchArm {
	return { bodyFirstColumn: column, bodyFirstLine: line, location: { ...location } };
}

function pointSpan({ column, line }: SourcePosition): LuauSpan {
	return { beginColumn: column, beginLine: line, endColumn: column, endLine: line };
}
