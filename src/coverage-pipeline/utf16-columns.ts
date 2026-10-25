import type { SourceBytes, Utf16Span } from "@isentinel/luau-ast";
import { indexSourceBytes } from "@isentinel/luau-ast";
import type { LuauSpan } from "@isentinel/luau-ast/ast";

import type { CollectorResult } from "./coverage-accumulator.ts";

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
export function toUtf16Columns(result: CollectorResult<LuauSpan>, source: string): CollectorResult {
	const bytes = indexSourceBytes(source);

	return {
		branches: result.branches.map((branch) => {
			return { ...branch, arms: branch.arms.map((arm) => convertBody(arm, bytes)) };
		}),
		functions: result.functions.map((func) => convertBody(func, bytes)),
		implicitElseProbes: result.implicitElseProbes.map((probe) => {
			return { ...probe, endColumn: bytes.toUtf16Column(probe.endLine, probe.endColumn) };
		}),
		statements: result.statements.map((statement) => {
			return { ...statement, location: bytes.toUtf16Span(statement.location) };
		}),
		wrapProbes: result.wrapProbes.map((probe) => {
			return { ...probe, exprLocation: bytes.toUtf16Span(probe.exprLocation) };
		}),
	};
}

/**
 * The shape a branch arm and a function share: a span plus the position of the
 * first statement of its body, which is where a point probe goes.
 */
function convertBody<
	T extends { bodyFirstColumn: number; bodyFirstLine: number; location: LuauSpan },
>(node: T, bytes: SourceBytes): T & { location: Utf16Span } {
	// A `bodyFirstLine` of 0 is the "wrap probe, not point probe" sentinel: it
	// names no line, so there is nothing to convert it against.
	const isPointProbe = node.bodyFirstLine !== 0;

	return {
		...node,
		bodyFirstColumn: isPointProbe
			? bytes.toUtf16Column(node.bodyFirstLine, node.bodyFirstColumn)
			: node.bodyFirstColumn,
		location: bytes.toUtf16Span(node.location),
	};
}
