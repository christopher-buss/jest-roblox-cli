import type { SourceBytes, Utf16Span } from "@isentinel/luau-ast";
import { indexSourceBytes } from "@isentinel/luau-ast";
import type { LuauSpan } from "@isentinel/luau-ast/ast";

import type { CollectorResult } from "./coverage-accumulator.ts";

/**
 * Restates every column in `result` as a 1-based UTF-16 offset.
 * @param result - Collector result with byte columns.
 * @param source - The Luau source the result came from.
 * @returns The result with UTF-16 columns.
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
 * Convert a record from byte columns to UTF-16 columns.
 * @template T - Branch arm or function record.
 * @param node - Record with byte columns.
 * @param bytes - Byte index of the source.
 * @returns The record with UTF-16 columns.
 */
function convertBody<
	T extends { bodyFirstColumn: number; bodyFirstLine: number; location: LuauSpan },
>(node: T, bytes: SourceBytes): T & { location: Utf16Span } {
	const isPointProbe = node.bodyFirstLine !== 0;

	return {
		...node,
		bodyFirstColumn: isPointProbe
			? bytes.toUtf16Column(node.bodyFirstLine, node.bodyFirstColumn)
			: node.bodyFirstColumn,
		location: bytes.toUtf16Span(node.location),
	};
}
