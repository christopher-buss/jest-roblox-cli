import type { AstStat, AstStatBlock, LuauSpan } from "@isentinel/luau-ast/ast";
import type { ParseSuccess } from "@isentinel/luau-ast/parser";
import { visitBlock } from "@isentinel/luau-ast/visit";

import assert from "node:assert";
import { Buffer } from "node:buffer";

import type { TypeTestDiagnostic } from "./types.ts";

const DIRECTIVE = /^--\s*@expect-error(?:\s|$)/;
const LINE_SPLIT = /\r?\n/;

interface Directive {
	location: LuauSpan;
	target: LuauSpan | undefined;
}

export function applyLuauExpectErrors({
	diagnostics,
	filePath,
	parsed,
	source,
}: {
	diagnostics: Array<TypeTestDiagnostic>;
	filePath: string;
	parsed: ParseSuccess;
	source: string;
}): Array<TypeTestDiagnostic> {
	const directives = collectDirectives(source, parsed);
	if (directives.length === 0) {
		return diagnostics;
	}

	const used = new Set<Directive>();
	const remaining = diagnostics.filter((diagnostic) => {
		const directive = directives.find(
			({ target }) => target !== undefined && contains(target, diagnostic),
		);
		if (directive === undefined) {
			return true;
		}

		used.add(directive);
		return false;
	});

	for (const directive of directives) {
		if (!used.has(directive)) {
			remaining.push({
				code: "ExpectError",
				column: directive.location.beginColumn,
				filePath,
				line: directive.location.beginLine,
				message: "unused @expect-error",
			});
		}
	}

	return remaining;
}

function contains(
	span: LuauSpan,
	{ column, line }: Pick<TypeTestDiagnostic, "column" | "line">,
): boolean {
	const isAfterStart =
		line > span.beginLine || (line === span.beginLine && column >= span.beginColumn);
	const isBeforeEnd = line < span.endLine || (line === span.endLine && column < span.endColumn);
	return isAfterStart && isBeforeEnd;
}

function findTarget(statements: Array<AstStat>, line: number): LuauSpan | undefined {
	return statements.find(({ location }) => location.beginLine > line)?.location;
}

function collectDirectives(source: string, parsed: ParseSuccess): Array<Directive> {
	const lines = source.split(LINE_SPLIT).map((line) => Buffer.from(line));
	const comments = parsed.comments.filter(({ location, type }) => {
		const line = lines[location.beginLine - 1];
		return (
			type === "Comment" &&
			line !== undefined &&
			DIRECTIVE.test(line.subarray(location.beginColumn - 1).toString())
		);
	});
	if (comments.length === 0) {
		return [];
	}

	const blocks: Array<AstStatBlock> = [parsed.root];
	visitBlock(parsed.root, {
		visitStatBlock(block) {
			blocks.push(block);
			return true;
		},
	});

	return comments.map(({ location }) => {
		const point = { column: location.beginColumn, line: location.beginLine };
		const block = blocks.findLast(({ location: span }) => contains(span, point));
		assert(block, "luau-ast root block spans every comment");
		return { location, target: findTarget(block.body, location.beginLine) };
	});
}
