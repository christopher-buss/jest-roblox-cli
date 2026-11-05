import type { AstStat, AstStatBlock, LuauSpan } from "@isentinel/luau-ast/ast";
import type { ParseSuccess } from "@isentinel/luau-ast/parser";
import { visitBlock } from "@isentinel/luau-ast/visit";

import assert from "node:assert";
import { Buffer } from "node:buffer";

import type { TypeTestDiagnostic } from "./typecheck-types.ts";

const DIRECTIVE = /^--\s*@expect-error(?:\s|$)/;
const LINE_SPLIT = /\r?\n/;

interface Directive {
	location: LuauSpan;
	target: LuauSpan | undefined;
}

/**
 * Drop each diagnostic an `@expect-error` comment covers, and report every
 * directive that covered none.
 * @param options - The file's diagnostics, source and parse.
 * @param options.diagnostics - The checker's diagnostics for the file.
 * @param options.filePath - The file's path, for unused-directive errors.
 * @param options.parsed - The file's parse.
 * @param options.source - The file's source.
 * @returns The uncovered diagnostics plus one per unused directive.
 */
export function applyLuauExpectErrors({
	diagnostics,
	filePath,
	parsed,
	source,
}: {
	/** The checker's diagnostics for the file. */
	diagnostics: Array<TypeTestDiagnostic>;
	/** The file's path, for unused-directive errors. */
	filePath: string;
	/** The file's parse. */
	parsed: ParseSuccess;
	/** The file's source. */
	source: string;
}): Array<TypeTestDiagnostic> {
	const directives = collectDirectives(source, parsed);
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
	const comments = parsed.comments.filter(({ location }) => {
		return DIRECTIVE.test(
			String(lines[location.beginLine - 1]?.subarray(location.beginColumn - 1)),
		);
	});
	const blocks: Array<AstStatBlock> = [];
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
