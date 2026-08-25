import { indexSourceBytes } from "@isentinel/luau-ast";
import type { LuauSpan } from "@isentinel/luau-ast/ast";

import type { CollectorResult } from "./coverage-accumulator.ts";

/** Resolves a 1-based byte column on a 1-based line to a UTF-16 column. */
type ColumnConverter = (line: number, column: number) => number;

/**
 * Restates every column in `result` as a 1-based UTF-16 offset.
 *
 * lute reports byte columns — the Luau convention — but every consumer of a
 * {@link CollectorResult} indexes a JavaScript string: the probe inserter
 * slices each line at a column, and the columns that reach a roblox-ts source
 * map are UTF-16 code units on both sides of the lookup. On a line holding a
 * multi-byte character the two units drift apart and a probe lands inside the
 * character, so the units are reconciled once, here, where the parser's
 * numbers enter the pipeline.
 */
export function toUtf16Columns(result: CollectorResult, source: string): CollectorResult {
	const bytes = indexSourceBytes(source);
	// An all-ASCII file — the overwhelming majority — encodes to one byte per
	// UTF-16 unit, so every column already is a UTF-16 column.
	if (bytes.byteLength === source.length) {
		return result;
	}

	const convert = bytes.toUtf16Column;

	return {
		branches: result.branches.map((branch) => {
			return { ...branch, arms: branch.arms.map((arm) => convertBody(arm, convert)) };
		}),
		functions: result.functions.map((func) => convertBody(func, convert)),
		implicitElseProbes: result.implicitElseProbes.map((probe) => {
			return { ...probe, endColumn: convert(probe.endLine, probe.endColumn) };
		}),
		statements: result.statements.map((statement) => {
			return { ...statement, location: convertSpan(statement.location, convert) };
		}),
		wrapProbes: result.wrapProbes.map((probe) => {
			return { ...probe, exprLocation: convertSpan(probe.exprLocation, convert) };
		}),
	};
}

function convertSpan(span: LuauSpan, convert: ColumnConverter): LuauSpan {
	return {
		beginColumn: convert(span.beginLine, span.beginColumn),
		beginLine: span.beginLine,
		endColumn: convert(span.endLine, span.endColumn),
		endLine: span.endLine,
	};
}

/**
 * The shape a branch arm and a function share: a span plus the position of the
 * first statement of its body, which is where a point probe goes.
 */
function convertBody<
	T extends { bodyFirstColumn: number; bodyFirstLine: number; location: LuauSpan },
>(node: T, convert: ColumnConverter): T {
	// A `bodyFirstLine` of 0 is the "wrap probe, not point probe" sentinel: it
	// names no line, so there is nothing to convert it against.
	const isPointProbe = node.bodyFirstLine !== 0;

	return {
		...node,
		bodyFirstColumn: isPointProbe
			? convert(node.bodyFirstLine, node.bodyFirstColumn)
			: node.bodyFirstColumn,
		location: convertSpan(node.location, convert),
	};
}
