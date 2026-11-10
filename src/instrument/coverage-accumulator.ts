import type { LuauSpan, Utf16Span } from "@isentinel/luau-ast/ast";

/**
 * Collected records. A new non-span column field must also convert in
 * `toUtf16Columns`.
 * @template Span - Column unit of every span.
 */
export interface CollectorResult<Span extends LuauSpan = Utf16Span> {
	/** Branch records, in index order. */
	branches: Array<BranchInfo<Span>>;
	/** Function records, in index order. */
	functions: Array<FunctionInfo<Span>>;
	/** Probes for the synthetic arm of each `if` with no `else`. */
	implicitElseProbes: Array<ImplicitElseProbe>;
	/** Statement records, in index order. */
	statements: Array<StatementInfo<Span>>;
	/** Operand expressions to wrap with `__cov_br`. */
	wrapProbes: Array<WrapProbe<Span>>;
}

/** A line/column pair in the original Luau source. */
export interface SourcePosition {
	/** Column on that line. */
	column: number;
	/** Source line. */
	line: number;
}

/** One arm of a statement branch, carrying the real position of its body. */
export interface StatementBranchArm {
	/** Start of the arm's body, where its point probe goes. */
	bodyFirst: SourcePosition;
	/** Span of the whole arm. */
	location: LuauSpan;
}

interface StatementInfo<Span extends LuauSpan> {
	index: number;
	location: Span;
}

interface FunctionInfo<Span extends LuauSpan> {
	name: string;
	bodyFirstColumn: number;
	bodyFirstLine: number;
	index: number;
	location: Span;
}

// `bodyFirstLine: 0` marks a wrap-probe arm; `probe-inserter.ts` skips its
// point probe.
interface BranchArmInfo<Span extends LuauSpan> {
	bodyFirstColumn: number;
	bodyFirstLine: number;
	location: Span;
}

interface BranchInfo<Span extends LuauSpan> {
	arms: Array<BranchArmInfo<Span>>;
	branchType: string;
	index: number;
}

interface ImplicitElseProbe {
	armIndex: number;
	branchIndex: number;
	endColumn: number;
	endLine: number;
}

interface WrapProbe<Span extends LuauSpan> {
	armIndex: number;
	branchIndex: number;
	exprLocation: Span;
}

interface ImplicitElse {
	ifStart: SourcePosition;
	probeEnd: SourcePosition;
}

/** Gathers the records the probe inserter and coverage-map builder consume. */
class CoverageAccumulator {
	private readonly branches: Array<BranchInfo<LuauSpan>> = [];
	private readonly functions: Array<FunctionInfo<LuauSpan>> = [];
	private readonly implicitElseProbes: Array<ImplicitElseProbe> = [];
	private readonly statements: Array<StatementInfo<LuauSpan>> = [];
	private readonly wrapProbes: Array<WrapProbe<LuauSpan>> = [];

	private branchIndex = 1;
	private functionIndex = 1;
	private statementIndex = 1;

	/**
	 * Records a branch whose arms each get a `__cov_br` wrap probe.
	 * @param branchType - Istanbul branch type, e.g. `binary-expr`.
	 * @param armLocations - Arm expressions, in source order.
	 */
	public addExpressionBranch(branchType: string, armLocations: Array<LuauSpan>): void {
		const index = this.branchIndex;
		this.branchIndex++;

		this.branches.push({
			arms: armLocations.map((location) => makeWrapArm(location)),
			branchType,
			index,
		});

		for (const [offset, location] of armLocations.entries()) {
			this.wrapProbes.push({
				armIndex: offset + 1,
				branchIndex: index,
				exprLocation: { ...location },
			});
		}
	}

	public addFunction({
		name,
		location,
		start: { column, line },
	}: {
		location: LuauSpan;
		name: string;
		start: SourcePosition;
	}): void {
		this.functions.push({
			name,
			bodyFirstColumn: column,
			bodyFirstLine: line,
			index: this.functionIndex,
			location: { ...location },
		});
		this.functionIndex++;
	}

	public addStatement(location: LuauSpan): void {
		this.statements.push({ index: this.statementIndex, location: { ...location } });
		this.statementIndex++;
	}

	/**
	 * Records a statement-`if` branch, whose arms carry real body positions.
	 * @param arms - The `then`, `elseif` and `else` arms, in order.
	 * @param implicitElse - Set when the source has no `else`.
	 */
	public addStatementBranch(arms: Array<StatementBranchArm>, implicitElse?: ImplicitElse): void {
		const index = this.branchIndex;
		this.branchIndex++;

		const branchArms = arms.map((arm) => makeStatementArm(arm));
		if (implicitElse !== undefined) {
			const { ifStart, probeEnd } = implicitElse;
			branchArms.push(makeImplicitElseArm(ifStart));
			this.implicitElseProbes.push({
				armIndex: branchArms.length,
				branchIndex: index,
				endColumn: probeEnd.column,
				endLine: probeEnd.line,
			});
		}

		this.branches.push({ arms: branchArms, branchType: "if", index });
	}

	public result(): CollectorResult<LuauSpan> {
		return {
			branches: this.branches,
			functions: this.functions,
			implicitElseProbes: this.implicitElseProbes,
			statements: this.statements,
			wrapProbes: this.wrapProbes,
		};
	}
}

export type { CoverageAccumulator };

/**
 * Start an empty accumulator for one file.
 * @returns An accumulator with every counter at index zero.
 */
export function createCoverageAccumulator(): CoverageAccumulator {
	return new CoverageAccumulator();
}

function makeWrapArm(location: LuauSpan): BranchArmInfo<LuauSpan> {
	return { bodyFirstColumn: 0, bodyFirstLine: 0, location: { ...location } };
}

function makeStatementArm({ bodyFirst, location }: StatementBranchArm): BranchArmInfo<LuauSpan> {
	return {
		bodyFirstColumn: bodyFirst.column,
		bodyFirstLine: bodyFirst.line,
		location: { ...location },
	};
}

function makeImplicitElseArm({ column, line }: SourcePosition): BranchArmInfo<LuauSpan> {
	return {
		bodyFirstColumn: 0,
		bodyFirstLine: 0,
		location: { beginColumn: column, beginLine: line, endColumn: column, endLine: line },
	};
}
