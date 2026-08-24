import type { LuauSpan } from "@isentinel/luau-ast/ast";

/**
 * Columns here are UTF-16, not the UTF-8 bytes {@link LuauSpan} arrives in:
 * `collectCoverage` runs the whole result through `toUtf16Columns` before
 * returning it. A new column-bearing field needs adding there too — the spread
 * that copies each record would otherwise carry it through in bytes.
 */
export interface CollectorResult {
	branches: Array<BranchInfo>;
	functions: Array<FunctionInfo>;
	implicitElseProbes: Array<ImplicitElseProbe>;
	statements: Array<StatementInfo>;
	wrapProbes: Array<WrapProbe>;
}

/** A line/column pair in the original Luau source. */
export interface SourcePosition {
	column: number;
	line: number;
}

/** One arm of a statement branch, carrying the real position of its body. */
export interface StatementBranchArm {
	bodyFirst: SourcePosition;
	location: LuauSpan;
}

interface StatementInfo {
	index: number;
	location: LuauSpan;
}

interface FunctionInfo {
	name: string;
	bodyFirstColumn: number;
	bodyFirstLine: number;
	index: number;
	location: LuauSpan;
}

/**
 * One arm of a branch.
 *
 * `bodyFirstLine: 0` / `bodyFirstColumn: 0` is a sentinel meaning the arm is
 * covered by a wrap probe (`__cov_br`, see {@link WrapProbe}) rather than a
 * statement point probe (`__cov_b[n][m] += 1`). `probe-inserter.ts` skips
 * point probes for any arm with `bodyFirstLine === 0`. Both `binary-expr`
 * (`and`/`or`) and `expr-if` arms use this convention; statement-`if` arms
 * carry real body positions.
 */
interface BranchArmInfo {
	bodyFirstColumn: number;
	bodyFirstLine: number;
	location: LuauSpan;
}

interface BranchInfo {
	arms: Array<BranchArmInfo>;
	branchType: string;
	index: number;
}

interface ImplicitElseProbe {
	armIndex: number;
	branchIndex: number;
	endColumn: number;
	endLine: number;
}

/**
 * An operand expression to wrap with the `__cov_br` runtime helper. Shared by
 * expression-`if` arms and `and`/`or` operands — both are instrumented by
 * wrapping the original expression so its value flows through unchanged while a
 * branch counter is bumped, preserving short-circuit semantics.
 */
interface WrapProbe {
	armIndex: number;
	branchIndex: number;
	exprLocation: LuauSpan;
}

/** Placement data for the synthetic arm of an `if` with no `else` block. */
interface ImplicitElse {
	/** Start of the `if` statement — stands in for the synthetic arm's span. */
	ifStart: SourcePosition;
	/** End of the last real arm's body, where the arm's probe is inserted. */
	probeEnd: SourcePosition;
}

/**
 * Gathers the records the probe inserter and coverage-map builder consume, and
 * owns the bookkeeping the collectors must not have to repeat: the 1-based
 * index allocation for each of the three counters, the wrap-probe sentinel, and
 * the 1..N `armIndex` pairing between a branch's arms and their probes.
 */
class CoverageAccumulator {
	private readonly branches: Array<BranchInfo> = [];
	private readonly functions: Array<FunctionInfo> = [];
	private readonly implicitElseProbes: Array<ImplicitElseProbe> = [];
	private readonly statements: Array<StatementInfo> = [];
	private readonly wrapProbes: Array<WrapProbe> = [];

	private branchIndex = 1;
	private functionIndex = 1;
	private statementIndex = 1;

	/**
	 * Records a branch whose arms are instrumented by wrapping the arm
	 * expression itself — `and`/`or` operands and expression-`if` arms. Every
	 * arm gets the {@link BranchArmInfo} sentinel and its own wrap probe.
	 *
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

	public addFunction(name: string, location: LuauSpan, { column, line }: SourcePosition): void {
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
	 *
	 * @param arms - The `then` arm followed by every `elseif` arm, plus the
	 *   `else` arm when the source has one.
	 * @param implicitElse - Set when the source has no `else`, appending the
	 *   synthetic arm and the probe that stands in for it.
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

	public result(): CollectorResult {
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

export function createCoverageAccumulator(): CoverageAccumulator {
	return new CoverageAccumulator();
}

function makeWrapArm(location: LuauSpan): BranchArmInfo {
	return { bodyFirstColumn: 0, bodyFirstLine: 0, location: { ...location } };
}

function makeStatementArm({ bodyFirst, location }: StatementBranchArm): BranchArmInfo {
	return {
		bodyFirstColumn: bodyFirst.column,
		bodyFirstLine: bodyFirst.line,
		location: { ...location },
	};
}

function makeImplicitElseArm({ column, line }: SourcePosition): BranchArmInfo {
	return {
		bodyFirstColumn: 0,
		bodyFirstLine: 0,
		location: { beginColumn: column, beginLine: line, endColumn: column, endLine: line },
	};
}
