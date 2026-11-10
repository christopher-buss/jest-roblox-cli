import assert from "node:assert";

import { countLinesThroughLastDirective } from "../luau/directive-header.ts";
import { COVERAGE_GLOBAL, type CoverageBucket } from "../protocol/coverage.ts";
import type { CollectorResult } from "./coverage-accumulator.ts";

type ProbeKind = "close" | "open" | "point";

interface ProbeInfo {
	column: number;
	kind: ProbeKind;
	line: number;
	spanColumn?: number;
	spanLine?: number;
	text: string;
}

// Probes apply right-to-left, so a lower rank ends up further right.
const KIND_RANK = { close: 2, open: 0, point: 1 } satisfies Record<ProbeKind, number>;
const TRAILING_WHITESPACE = /\s$/;

/**
 * Rewrite Luau source with coverage probes and the counter preamble.
 * @param options - File key, collected coverage sites and source text.
 * @returns The instrumented source, with any directive header kept first.
 */
export function insertProbes({
	fileKey,
	result,
	source,
}: {
	/** Key the counters are stored under. */
	fileKey: string;
	/** Coverage sites collected from the source. */
	result: CollectorResult;
	/** Luau source text. */
	source: string;
}): string {
	const lines = splitLines(source);
	const probes = collectProbes(result);

	applyProbes(lines, probes);

	const directiveHeader = extractDirectiveHeader(lines);

	if (!hasCoverageSites(result)) {
		return directiveHeader + lines.join("\n");
	}

	// Same line as the source: the stack-trace mapper reads the original's map,
	// so the twin must stay line-aligned with it.
	const firstLineParts = buildPreamble(fileKey, result);
	const [originalFirstLine] = lines;
	assert(originalFirstLine !== undefined);
	firstLineParts.push(originalFirstLine);

	lines[0] = firstLineParts.join("; ");

	return directiveHeader + lines.join("\n");
}

function compareProbes(left: ProbeInfo, right: ProbeInfo): number {
	if (left.column !== right.column) {
		return right.column - left.column;
	}

	if (KIND_RANK[left.kind] !== KIND_RANK[right.kind]) {
		return KIND_RANK[left.kind] - KIND_RANK[right.kind];
	}

	if (
		left.spanLine !== undefined &&
		right.spanLine !== undefined &&
		left.spanLine !== right.spanLine
	) {
		return left.spanLine - right.spanLine;
	}

	if (left.spanColumn !== undefined && right.spanColumn !== undefined) {
		return left.spanColumn - right.spanColumn;
	}

	return 0;
}

function statementProbes(result: CollectorResult): Array<ProbeInfo> {
	return Array.from(result.statements, (stmt) => {
		return {
			column: stmt.location.beginColumn,
			kind: "point",
			line: stmt.location.beginLine,
			text: `__cov_s[${stmt.index}] += 1; `,
		};
	});
}

function functionProbes(result: CollectorResult): Array<ProbeInfo> {
	const probes: Array<ProbeInfo> = [];

	for (const func of result.functions) {
		if (func.bodyFirstLine > 0) {
			probes.push({
				column: func.bodyFirstColumn,
				kind: "point",
				line: func.bodyFirstLine,
				text: `__cov_f[${func.index}] += 1; `,
			});
		}
	}

	return probes;
}

function branchPointProbes(result: CollectorResult): Array<ProbeInfo> {
	const probes: Array<ProbeInfo> = [];

	for (const branch of result.branches) {
		for (const [armIndex, arm] of branch.arms.entries()) {
			if (arm.bodyFirstLine > 0) {
				probes.push({
					column: arm.bodyFirstColumn,
					kind: "point",
					line: arm.bodyFirstLine,
					text: `__cov_b[${branch.index}][${armIndex + 1}] += 1; `,
				});
			}
		}
	}

	for (const probe of result.implicitElseProbes) {
		probes.push({
			column: probe.endColumn,
			kind: "point",
			line: probe.endLine,
			text: `else __cov_b[${probe.branchIndex}][${probe.armIndex}] += 1 `,
		});
	}

	return probes;
}

function pointProbes(result: CollectorResult): Array<ProbeInfo> {
	return [...statementProbes(result), ...functionProbes(result), ...branchPointProbes(result)];
}

function wrapProbes(result: CollectorResult): Array<ProbeInfo> {
	const probes: Array<ProbeInfo> = [];

	for (const probe of result.wrapProbes) {
		const { beginColumn, beginLine, endColumn, endLine } = probe.exprLocation;
		probes.push(
			{
				column: beginColumn,
				kind: "open",
				line: beginLine,
				spanColumn: endColumn,
				spanLine: endLine,
				text: `__cov_br(${probe.branchIndex}, ${probe.armIndex}, `,
			},
			{
				column: endColumn,
				kind: "close",
				line: endLine,
				spanColumn: beginColumn,
				spanLine: beginLine,
				text: ")",
			},
		);
	}

	return probes;
}

function collectProbes(result: CollectorResult): Array<ProbeInfo> {
	return [...pointProbes(result), ...wrapProbes(result)].sort(compareProbes);
}

/**
 * `probes` must be sorted by `compareProbes`.
 *
 * @param mutableLines - Source lines, edited in place.
 * @param probes - Probes to insert at their positions.
 */
function applyProbes(mutableLines: Array<string>, probes: Array<ProbeInfo>): void {
	for (const { column, kind, line: probeLine, text } of probes) {
		const lineIndex = probeLine - 1;
		const line = mutableLines[lineIndex];
		assert(line !== undefined);
		const before = line.slice(0, column - 1);
		const after = line.slice(column - 1);
		const shouldInsertSeparator =
			before.length > 0 && !TRAILING_WHITESPACE.test(before) && kind !== "close";
		mutableLines[lineIndex] = before + (shouldInsertSeparator ? " " : "") + text + after;
	}
}

/**
 * The preamble must follow the header: a `--!` line after code is no
 * directive.
 *
 * @param lines - Source lines; the header lines are removed.
 * @returns The header lines, each ending in a newline.
 */
function extractDirectiveHeader(lines: Array<string>): string {
	return lines
		.splice(0, countLinesThroughLastDirective(lines))
		.map((headerLine) => `${headerLine}\n`)
		.join("");
}

function splitLines(source: string): Array<string> {
	const lines: Array<string> = [];
	let position = 0;

	while (position < source.length) {
		const nlPosition = source.indexOf("\n", position);
		if (nlPosition !== -1) {
			let lineEnd = nlPosition;
			if (source[lineEnd - 1] === "\r") {
				lineEnd--;
			}

			lines.push(source.slice(position, lineEnd));
			position = nlPosition + 1;
		} else {
			lines.push(source.slice(position));
			position = source.length;
		}
	}

	return lines;
}

function hasCoverageSites(result: CollectorResult): boolean {
	return (
		result.statements.length > 0 || result.functions.length > 0 || result.branches.length > 0
	);
}

/**
 * Sole escaper of the file key, which must match `instrumentRoot`'s manifest.
 *
 * @param value - Text to embed in a double-quoted Luau string.
 * @returns The escaped text, with NUL characters removed.
 */
function escapeLuauString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\0", "");
}

function bindBucket(field: CoverageBucket): Array<string> {
	const bucket = `_G.${COVERAGE_GLOBAL}[__cov_file_key].${field}`;
	return [`if ${bucket} == nil then ${bucket} = {} end`, `local __cov_${field} = ${bucket}`];
}

function buildBranchInit(result: CollectorResult): Array<string> {
	if (result.branches.length === 0) {
		return [];
	}

	const statements = bindBucket("b");
	for (const branch of result.branches) {
		const zeros = branch.arms.map(() => "0").join(", ");
		statements.push(
			`if __cov_b[${branch.index}] == nil then __cov_b[${branch.index}] = {${zeros}} end`,
		);
	}

	if (result.wrapProbes.length > 0) {
		statements.push(
			"local function __cov_br(__bi, __ai, ...) __cov_b[__bi][__ai] += 1; return ... end",
		);
	}

	return statements;
}

function zeroFill(field: "f" | "s", count: number): string {
	return `for __i = 1, ${count} do if __cov_${field}[__i] == nil then __cov_${field}[__i] = 0 end end`;
}

function buildPreamble(fileKey: string, result: CollectorResult): Array<string> {
	const escapedKey = escapeLuauString(fileKey);

	const statements = [
		`if _G.${COVERAGE_GLOBAL} == nil then _G.${COVERAGE_GLOBAL} = {} end`,
		`local __cov_file_key = "${escapedKey}"`,
		`if _G.${COVERAGE_GLOBAL}[__cov_file_key] == nil then _G.${COVERAGE_GLOBAL}[__cov_file_key] = {} end`,
		...bindBucket("s"),
	];

	if (result.statements.length > 0) {
		statements.push(zeroFill("s", result.statements.length));
	}

	if (result.functions.length > 0) {
		statements.push(...bindBucket("f"), zeroFill("f", result.functions.length));
	}

	statements.push(...buildBranchInit(result));

	return statements;
}
