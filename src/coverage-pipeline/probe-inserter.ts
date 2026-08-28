import assert from "node:assert";

import type { CollectorResult } from "./coverage-collector.ts";

/**
 * `point` — a self-contained insertion (`__cov_s`/`__cov_f`/`__cov_b` bump).
 * `open`/`close` — the two halves of an expression wrap (`__cov_br(bi, ai, ` …
 * `)`). For a wrap, `spanLine`/`spanColumn` carry the *other* end of the
 * wrapped span (an `open` carries its close position, a `close` its open
 * position) so colliding nested wraps can be ordered to nest correctly.
 */
type ProbeKind = "close" | "open" | "point";

interface ProbeInfo {
	column: number;
	kind: ProbeKind;
	line: number;
	spanColumn?: number;
	spanLine?: number;
	text: string;
}

// At one position the final left-to-right order is: closes, points, opens, then
// the original character. The probe array is applied right-to-left (a later
// application lands further left), so a lower rank here is applied earlier and
// ends up further right.
const KIND_RANK = { close: 2, open: 0, point: 1 } satisfies Record<ProbeKind, number>;
const TRAILING_WHITESPACE = /\s$/;
const MODE_DIRECTIVE = /^--![a-z]/;

export function insertProbes(source: string, result: CollectorResult, fileKey: string): string {
	const lines = splitLines(source);
	const probes = collectProbes(result);

	applyProbes(lines, probes);

	const modeDirectives = extractModeDirectives(lines);

	// A file with nothing to count declares nothing, so the twin is its source
	// verbatim. Emitting anyway would need a line the source does not have when
	// directives are the whole file: appended, the preamble lands inside that
	// comment; prepended, the directive stops opening the file.
	if (!hasCoverageSites(result)) {
		return modeDirectives + lines.join("\n");
	}

	// The preamble shares the first line that survives the directive strip: the
	// runtime reports frame lines against this twin, but the stack-trace mapper
	// reads the source map of the original file, so the twin stays line-for-line
	// aligned with it. Joined with `;` rather than a space so a first line
	// opening with `(` cannot read as a call on the statement before it. Lines
	// align, positions do not — the shared line's columns sit right of the
	// original's by the preamble's width. That reaches the mapper only through
	// a frame on the shared line carrying a column, which a Luau traceback does
	// not emit, and even then the mapper recomputes the TypeScript column from
	// the mapped line's text rather than from the map.
	const firstLineParts = buildPreamble(fileKey, result);
	const [originalFirstLine] = lines;
	// A site sits on a line, so the strip above cannot have taken the last one.
	assert(originalFirstLine !== undefined, "Coverage sites with no line to hold them");
	firstLineParts.push(originalFirstLine);

	lines[0] = firstLineParts.join("; ");

	return modeDirectives + lines.join("\n");
}

/**
 * Apply right-to-left (later insertion lands further left), so sort descending
 * by (line, column). At a shared position, order by kind and then by the wrap's
 * opposite end so nested wraps surround inner ones; point probes keep their
 * (stable) insertion order.
 */
function compareProbes(left: ProbeInfo, right: ProbeInfo): number {
	if (left.line !== right.line) {
		return right.line - left.line;
	}

	if (left.column !== right.column) {
		return right.column - left.column;
	}

	if (KIND_RANK[left.kind] !== KIND_RANK[right.kind]) {
		return KIND_RANK[left.kind] - KIND_RANK[right.kind];
	}

	// Ascending here, unlike the descending primary sort — same direction as
	// KIND_RANK: a probe sorted earlier is applied earlier and ends up further
	// right, so the inner wrap (nearer far end for an open, nearer near end for
	// a close) lands closest to the operand.
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

/**
 * Arm-body bumps, followed by the implicit-`else` bumps that give an `if`
 * without an `else` a countable second arm.
 */
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

/**
 * Every self-contained bump: statements, function bodies, branch arm bodies and
 * the synthesized `else` arm an `if` without one still needs to count.
 */
function pointProbes(result: CollectorResult): Array<ProbeInfo> {
	return [...statementProbes(result), ...functionProbes(result), ...branchPointProbes(result)];
}

/** The two halves of each expression wrap, emitted as an adjacent pair. */
function wrapProbes(result: CollectorResult): Array<ProbeInfo> {
	const probes: Array<ProbeInfo> = [];

	for (const probe of result.wrapProbes) {
		const { beginColumn, beginLine, endColumn, endLine } = probe.exprLocation;
		// Wrap the operand: `__cov_br(bi, ai, <operand>)`. The helper bumps the
		// branch counter and returns its varargs unchanged, so the value — and,
		// for `and`/`or`, the short-circuit — is preserved.
		probes.push(
			{
				column: beginColumn,
				kind: "open",
				line: beginLine,
				// An open is ordered by its close position so a wider (outer)
				// open at the same column lands left of a narrower (inner) one.
				spanColumn: endColumn,
				spanLine: endLine,
				text: `__cov_br(${probe.branchIndex}, ${probe.armIndex}, `,
			},
			{
				column: endColumn,
				kind: "close",
				line: endLine,
				// A close is ordered by its open position so a wider (outer)
				// close at the same column lands right of a narrower (inner) one.
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
 * Mutates `mutableLines` in place, inserting probe text at each probe's
 * position.
 */
function applyProbes(mutableLines: Array<string>, probes: Array<ProbeInfo>): void {
	for (const { column, kind, line: probeLine, text } of probes) {
		const lineIndex = probeLine - 1;
		const line = mutableLines[lineIndex];
		assert(line !== undefined, `Invalid probe line number: ${probeLine}`);
		const before = line.slice(0, column - 1);
		const after = line.slice(column - 1);
		const shouldInsertSeparator =
			before.length > 0 && !TRAILING_WHITESPACE.test(before) && kind !== "close";
		mutableLines[lineIndex] = before + (shouldInsertSeparator ? " " : "") + text + after;
	}
}

/**
 * Luau reads hot comments only from the run of lines that opens a file, so the
 * whole run has to lead the preamble. It moves intact: a directive left behind
 * compiles the twin under settings the original never asked for.
 */
function extractModeDirectives(lines: Array<string>): string {
	let directiveCount = 0;
	for (const line of lines) {
		if (!MODE_DIRECTIVE.test(line)) {
			break;
		}

		directiveCount += 1;
	}

	return lines
		.splice(0, directiveCount)
		.map((directive) => `${directive}\n`)
		.join("");
}

// Splits source into lines, stripping \r from CRLF endings.
// Rejoined with \n only — Luau is LF-only.
function splitLines(source: string): Array<string> {
	const lines: Array<string> = [];
	let position = 0;

	while (position < source.length) {
		const nlPosition = source.indexOf("\n", position);
		if (nlPosition !== -1) {
			let lineEnd = nlPosition;
			if (lineEnd > position && source[lineEnd - 1] === "\r") {
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

/** Whether the file has anything a counter table would hold. */
function hasCoverageSites(result: CollectorResult): boolean {
	return (
		result.statements.length > 0 || result.functions.length > 0 || result.branches.length > 0
	);
}

/**
 * The only escaper for the file key. `local __cov_file_key = "<escaped>"` is
 * one half of the cross-machine join key pair — the other half is the manifest
 * record `instrumentRoot` writes from the same string — so a second escaper
 * would silently split the two.
 */
function escapeLuauString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\0", "");
}

/**
 * The one emitter for a counter bucket's `ensure the table, then bind a local`
 * pair. Three buckets share it so the field letter cannot drift between the
 * `nil` guard, the assignment, and the local the probes read.
 */
function bindBucket(field: "b" | "f" | "s"): Array<string> {
	const bucket = `_G.__jest_roblox_cov[__cov_file_key].${field}`;
	return [`if ${bucket} == nil then ${bucket} = {} end`, `local __cov_${field} = ${bucket}`];
}

/**
 * The branch half of the preamble: the shared `__cov_b` table, one zero-filled
 * arm vector per branch, and the `__cov_br` wrap helper when any expression
 * wrap probe needs it. Empty when the file has no branches.
 */
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

/** Zeroes every slot of a bucket the caller has already bound. */
function zeroFill(field: "f" | "s", count: number): string {
	return `for __i = 1, ${count} do if __cov_${field}[__i] == nil then __cov_${field}[__i] = 0 end end`;
}

/** Every statement the file's probes need in scope, in dependency order. */
function buildPreamble(fileKey: string, result: CollectorResult): Array<string> {
	const escapedKey = escapeLuauString(fileKey);

	const statements = [
		"if _G.__jest_roblox_cov == nil then _G.__jest_roblox_cov = {} end",
		`local __cov_file_key = "${escapedKey}"`,
		"if _G.__jest_roblox_cov[__cov_file_key] == nil then _G.__jest_roblox_cov[__cov_file_key] = {} end",
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
