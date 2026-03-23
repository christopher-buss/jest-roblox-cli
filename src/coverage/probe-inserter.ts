import assert from "node:assert";

import type { CollectorResult } from "./coverage-collector.ts";

interface ProbeInfo {
	column: number;
	line: number;
	text: string;
}

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
			column: stmt.location.begincolumn,
			line: stmt.location.beginline,
			text: `__cov_s[${stmt.index}] += 1; `,
		});
	}

	for (const func of result.functions) {
		if (func.bodyFirstLine > 0) {
			probes.push({
				column: func.bodyFirstColumn,
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
					line: arm.bodyFirstLine,
					text: `__cov_b[${branch.index}][${armIndex + 1}] += 1; `,
				});
			}
		}
	}

	for (const probe of result.implicitElseProbes) {
		probes.push({
			column: probe.endColumn,
			line: probe.endLine,
			text: `else __cov_b[${probe.branchIndex}][${probe.armIndex}] += 1 `,
		});
	}

	for (const probe of result.exprIfProbes) {
		// Prefix: wrap expression start with __cov_br(bi, ai,
		probes.push(
			{
				column: probe.exprLocation.begincolumn,
				line: probe.exprLocation.beginline,
				text: `__cov_br(${probe.branchIndex}, ${probe.armIndex}, `,
			},
			{
				column: probe.exprLocation.endcolumn,
				line: probe.exprLocation.endline,
				text: ")",
			},
		);
	}

	// Sort reverse by (line, column) for safe bottom-to-top insertion
	probes.sort((a, b) => {
		if (a.line === b.line) {
			return b.column - a.column;
		}

		return b.line - a.line;
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
		mutableLines[lineIndex] = before + text + after;
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

		if (result.exprIfProbes.length > 0) {
			preamble +=
				"local function __cov_br(__bi, __ai, ...) __cov_b[__bi][__ai] += 1; return ... end\n";
		}
	}

	return preamble;
}
