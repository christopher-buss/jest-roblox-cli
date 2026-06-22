import assert from "node:assert";

import type { CollectorResult } from "./coverage-collector.ts";

/**
 * `point` — a self-contained insertion (`__cov_s`/`__cov_f`/`__cov_b` bump).
 * `open`/`close` — the two halves of an expression wrap (`__cov_br(bi, ai, ` …
 * `)`). For a wrap, `spanLine`/`spanColumn` carry the *other* end of the wrapped
 * span (an `open` carries its close position, a `close` its open position) so
 * colliding nested wraps can be ordered to nest correctly.
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
const KIND_RANK: Record<ProbeKind, number> = { close: 2, open: 0, point: 1 };

export function insertProbes(source: string, result: CollectorResult, fileKey: string): string {
	const lines = splitLines(source);
	const probes = collectProbes(result);

	applyProbes(lines, probes);

	const modeDirective = extractModeDirective(lines);
	const preamble = buildPreamble(modeDirective, fileKey, result);

	return preamble + lines.join("\n");
}

function collectProbes(result: CollectorResult): Array<ProbeInfo> {
	const probes: Array<ProbeInfo> = [];

	for (const stmt of result.statements) {
		probes.push({
			column: stmt.location.beginColumn,
			kind: "point",
			line: stmt.location.beginLine,
			text: `__cov_s[${stmt.index}] += 1; `,
		});
	}

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

	for (const branch of result.branches) {
		for (let armIndex = 0; armIndex < branch.arms.length; armIndex++) {
			const arm = branch.arms[armIndex];
			if (arm !== undefined && arm.bodyFirstLine > 0) {
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

	// Apply right-to-left (later insertion lands further left), so sort
	// descending by (line, column). At a shared position, order by kind and then
	// by the wrap's opposite end so nested wraps surround inner ones; point
	// probes keep their (stable) insertion order.
	probes.sort((a, b) => {
		if (a.line !== b.line) {
			return b.line - a.line;
		}

		if (a.column !== b.column) {
			return b.column - a.column;
		}

		if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
			return KIND_RANK[a.kind] - KIND_RANK[b.kind];
		}

		// Ascending here, unlike the descending primary sort — same direction as
		// KIND_RANK: a probe sorted earlier is applied earlier and ends up
		// further right, so the inner wrap (nearer far end for an open, nearer
		// near end for a close) lands closest to the operand.
		if (a.spanLine !== undefined && b.spanLine !== undefined && a.spanLine !== b.spanLine) {
			return a.spanLine - b.spanLine;
		}

		if (a.spanColumn !== undefined && b.spanColumn !== undefined) {
			return a.spanColumn - b.spanColumn;
		}

		return 0;
	});

	return probes;
}

/** Mutates `mutableLines` in place, inserting probe text at each probe's position. */
function applyProbes(mutableLines: Array<string>, probes: Array<ProbeInfo>): void {
	for (const { column, line: probeLine, text } of probes) {
		const lineIndex = probeLine - 1;
		const line = mutableLines[lineIndex];
		assert(line !== undefined, `Invalid probe line number: ${probeLine}`);
		const before = line.slice(0, column - 1);
		const after = line.slice(column - 1);
		const needsSeparator = before.length > 0 && !/\s$/.test(before) && /^[a-zA-Z_]/.test(text);
		mutableLines[lineIndex] = before + (needsSeparator ? " " : "") + text + after;
	}
}

function extractModeDirective(lines: Array<string>): string {
	if (lines.length > 0 && lines[0] !== undefined && /^--![a-z]+/.test(lines[0])) {
		const directive = `${lines[0]}\n`;
		lines.splice(0, 1);
		return directive;
	}

	return "";
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

	if (lines.length === 0) {
		lines.push("");
	}

	return lines;
}

function buildPreamble(modeDirective: string, fileKey: string, result: CollectorResult): string {
	const escapedKey = fileKey
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\0", "");

	let preamble = modeDirective;
	preamble += "if _G.__jest_roblox_cov == nil then _G.__jest_roblox_cov = {} end\n";
	preamble += `local __cov_file_key = "${escapedKey}"\n`;
	preamble +=
		"if _G.__jest_roblox_cov[__cov_file_key] == nil then _G.__jest_roblox_cov[__cov_file_key] = {} end\n";
	preamble +=
		"if _G.__jest_roblox_cov[__cov_file_key].s == nil then _G.__jest_roblox_cov[__cov_file_key].s = {} end\n";
	preamble += "local __cov_s = _G.__jest_roblox_cov[__cov_file_key].s\n";

	if (result.statements.length > 0) {
		preamble += `for __i = 1, ${result.statements.length} do if __cov_s[__i] == nil then __cov_s[__i] = 0 end end\n`;
	}

	if (result.functions.length > 0) {
		preamble +=
			"if _G.__jest_roblox_cov[__cov_file_key].f == nil then _G.__jest_roblox_cov[__cov_file_key].f = {} end\n";
		preamble += "local __cov_f = _G.__jest_roblox_cov[__cov_file_key].f\n";
		preamble += `for __i = 1, ${result.functions.length} do if __cov_f[__i] == nil then __cov_f[__i] = 0 end end\n`;
	}

	if (result.branches.length > 0) {
		preamble +=
			"if _G.__jest_roblox_cov[__cov_file_key].b == nil then _G.__jest_roblox_cov[__cov_file_key].b = {} end\n";
		preamble += "local __cov_b = _G.__jest_roblox_cov[__cov_file_key].b\n";
		for (const branch of result.branches) {
			const zeros = branch.arms.map(() => "0").join(", ");
			preamble += `if __cov_b[${branch.index}] == nil then __cov_b[${branch.index}] = {${zeros}} end\n`;
		}

		if (result.wrapProbes.length > 0) {
			preamble +=
				"local function __cov_br(__bi, __ai, ...) __cov_b[__bi][__ai] += 1; return ... end\n";
		}
	}

	return preamble;
}
