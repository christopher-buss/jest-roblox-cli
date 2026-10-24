import type { AstExpr, AstExprCall, LuauSpan } from "@isentinel/luau-ast/ast";
import type { ParseSuccess } from "@isentinel/luau-ast/parser";
import { visitBlock } from "@isentinel/luau-ast/visit";

import assert from "node:assert";
import { Buffer } from "node:buffer";

import { luauParser } from "../luau/parser.ts";
import { buildAncestorChain } from "./ancestor-chain.ts";
import { applyLuauExpectErrors } from "./luau-expect-error.ts";
import type { CollectedFile, RawTestDefinition, TypeTestDiagnostic } from "./types.ts";

const LINE_SPLIT = /\r?\n/;
const MODE_DIRECTIVE = /^--!(nocheck|nonstrict|strict)\s*$/;

const STRICT_MESSAGE =
	"Luau Type Tests must start with --!strict; without it lute skips or relaxes the checks.";

export function createByteLocationsIndexMap(source: string): Map<string, number> {
	const map = new Map<string, number>();
	let offset = 0;
	let line = 1;
	let column = 1;

	for (const char of source) {
		map.set(`${String(line)}:${String(column)}`, offset);
		const size = Buffer.byteLength(char);
		offset += size;

		if (char === "\n") {
			line++;
			column = 1;
		} else {
			column += size;
		}
	}

	map.set(`${String(line)}:${String(column)}`, offset);
	return map;
}

export function collectLuauTestDefinitions(source: string, filePath: string): CollectedFile {
	const locations = createByteLocationsIndexMap(source);
	const parsed = luauParser.parse(source);
	if (!parsed.ok) {
		return fileProblem(locations, {
			code: "SyntaxError",
			filePath,
			message: parsed.errors.join("\n"),
		});
	}

	if (!hasStrictDirective(source, parsed)) {
		return fileProblem(locations, { code: "StrictMode", filePath, message: STRICT_MESSAGE });
	}

	const raw: Array<RawTestDefinition> = [];
	visitBlock(parsed.root, {
		visitExprCall(node) {
			const definition = extractDefinition(node, locations);
			if (definition) {
				raw.push(definition);
			}

			return true;
		},
	});

	return {
		definitions: buildAncestorChain(raw),
		locations,
		resolve: (diagnostics) => applyLuauExpectErrors({ diagnostics, filePath, parsed, source }),
	};
}

function fileProblem(
	locations: Map<string, number>,
	{ code, filePath, message }: Pick<TypeTestDiagnostic, "code" | "filePath" | "message">,
): CollectedFile {
	return {
		definitions: [],
		locations,
		resolve: () => [{ code, column: 0, filePath, line: 0, message }],
	};
}

function hasStrictDirective(source: string, parsed: ParseSuccess): boolean {
	const lines = source.split(LINE_SPLIT).map((line) => Buffer.from(line));
	const firstStatement = parsed.root.body[0]?.location.beginLine ?? Infinity;
	for (const { location, type } of parsed.comments) {
		if (location.beginLine >= firstStatement) {
			break;
		}

		const line = lines[location.beginLine - 1];
		if (type !== "Comment" || line === undefined) {
			continue;
		}

		const mode = MODE_DIRECTIVE.exec(line.subarray(location.beginColumn - 1).toString())?.[1];
		if (mode !== undefined) {
			return mode === "strict";
		}
	}

	return false;
}

function getCalleeName(callee: AstExpr): string | undefined {
	let current = callee;
	while (current.type === "AstExprInstantiate") {
		current = current.expr;
	}

	if (current.type === "AstExprGlobal") {
		return current.global;
	}

	if (current.type === "AstExprIndexName") {
		return current.index;
	}

	return current.type === "AstExprLocal" ? current.local.name : undefined;
}

function offsetOf(
	locations: Map<string, number>,
	{ column, line }: { column: number; line: number },
): number {
	const offset = locations.get(`${String(line)}:${String(column)}`);
	assert(
		offset !== undefined,
		`luau-ast span ${String(line)}:${String(column)} is outside the source`,
	);
	return offset;
}

function spanOffsets(
	span: LuauSpan,
	locations: Map<string, number>,
): { end: number; start: number } {
	return {
		end: offsetOf(locations, { column: span.endColumn, line: span.endLine }),
		start: offsetOf(locations, { column: span.beginColumn, line: span.beginLine }),
	};
}

function extractDefinition(
	node: AstExprCall,
	locations: Map<string, number>,
): RawTestDefinition | undefined {
	const name = getCalleeName(node.func);
	if (name !== "describe" && name !== "it") {
		return undefined;
	}

	const firstArgument = node.args[0];
	if (firstArgument?.type !== "AstExprConstantString") {
		return undefined;
	}

	return {
		name: firstArgument.value,
		...spanOffsets(node.location, locations),
		type: name === "it" ? "test" : "suite",
	};
}
