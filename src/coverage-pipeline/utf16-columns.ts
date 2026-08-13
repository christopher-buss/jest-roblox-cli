import type { LuauSpan, Utf8OffsetMap } from "@isentinel/luau-ast";
import { createUtf8OffsetMap } from "@isentinel/luau-ast";

import { Buffer } from "node:buffer";

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
 * character, so the units are reconciled once, here, where lute's numbers enter
 * the pipeline.
 *
 * Converting further upstream, in `parse-ast.luau`, would be cheaper still, but
 * Luau counts code points rather than UTF-16 units and the AST sidecars it
 * caches would then carry a convention no other Luau tool uses.
 */
export function toUtf16Columns(result: CollectorResult, source: string): CollectorResult {
	// An all-ASCII file — the overwhelming majority — has byte columns that are
	// already UTF-16 columns.
	if (!hasMultiByte(source)) {
		return result;
	}

	const convert = createColumnConverter(source);

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

/**
 * Does `text` encode to more UTF-8 bytes than it has UTF-16 units? Every code
 * point outside ASCII does, so the two lengths agree exactly when nothing in
 * `text` needs converting.
 */
function hasMultiByte(text: string): boolean {
	return Buffer.byteLength(text, "utf-8") !== text.length;
}

function createColumnConverter(source: string): ColumnConverter {
	// Map only the lines that hold a multi-byte character; the rest already
	// agree. Split on "\n" alone, keeping any carriage return: lute counts
	// bytes from the start of the line, so dropping one would shift every
	// column past it.
	const multiByteLines = new Map<number, Utf8OffsetMap>();
	for (const [index, line] of source.split("\n").entries()) {
		if (hasMultiByte(line)) {
			multiByteLines.set(index + 1, createUtf8OffsetMap(line));
		}
	}

	return (line, column) => {
		const offsets = multiByteLines.get(line);
		if (offsets === undefined) {
			return column;
		}

		// Both units count from 1 here, and the map from 0. An end column sits
		// one past the last byte, which the map answers with one past the last
		// UTF-16 unit.
		return offsets.toUtf16(column - 1) + 1;
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
	return {
		...node,
		bodyFirstColumn: convert(node.bodyFirstLine, node.bodyFirstColumn),
		location: convertSpan(node.location, convert),
	};
}
