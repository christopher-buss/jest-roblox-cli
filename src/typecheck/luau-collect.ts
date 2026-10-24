import type { AstExpr, AstExprCall, LuauSpan } from "@isentinel/luau-ast/ast";
import { visitBlock } from "@isentinel/luau-ast/visit";

import assert from "node:assert";
import { Buffer } from "node:buffer";

import { luauParser } from "../luau/parser.ts";
import { buildAncestorChain } from "./collect.ts";
import type { CollectedFile, RawTestDefinition } from "./types.ts";

const LINE_SPLIT = /\r?\n/;
const STRICT_DIRECTIVE = /^--!strict\s*$/;

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

export function collectLuauTestDefinitions(source: string): CollectedFile {
	const parsed = luauParser.parse(source);
	if (!parsed.ok) {
		return {
			definitions: [],
			problems: [{ code: "SyntaxError", message: parsed.errors.join("\n") }],
		};
	}

	if (!hasStrictDirective(source)) {
		return { definitions: [], problems: [{ code: "StrictMode", message: STRICT_MESSAGE }] };
	}

	const locations = createByteLocationsIndexMap(source);
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

	return { definitions: buildAncestorChain(raw), problems: [] };
}

function hasStrictDirective(source: string): boolean {
	for (const line of source.split(LINE_SPLIT)) {
		if (STRICT_DIRECTIVE.test(line)) {
			return true;
		}

		if (line.trim() !== "" && !line.startsWith("--")) {
			return false;
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
