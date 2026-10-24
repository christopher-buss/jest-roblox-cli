import type { AstStat, LuauSpan } from "@isentinel/luau-ast/ast";
import { visitBlock } from "@isentinel/luau-ast/visit";

import { Buffer } from "node:buffer";

import { luauParser } from "../luau/parser.ts";
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
	source,
}: {
	diagnostics: Array<TypeTestDiagnostic>;
	filePath: string;
	source: string;
}): Array<TypeTestDiagnostic> {
	const directives = collectDirectives(source);
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

function compare(a: LuauSpan, b: LuauSpan): number {
	return (
		a.beginLine - b.beginLine ||
		a.beginColumn - b.beginColumn ||
		b.endLine - a.endLine ||
		b.endColumn - a.endColumn
	);
}

function findTarget(statements: Array<AstStat>, line: number): LuauSpan | undefined {
	let best: LuauSpan | undefined;
	for (const { location } of statements) {
		if (location.beginLine <= line) {
			continue;
		}

		if (best === undefined || compare(location, best) < 0) {
			best = location;
		}
	}

	return best;
}

function collectDirectives(source: string): Array<Directive> {
	const parsed = luauParser.parse(source);
	if (!parsed.ok) {
		return [];
	}

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

	const statements: Array<AstStat> = [...parsed.root.body];
	visitBlock(parsed.root, {
		visitStatBlock(block) {
			statements.push(...block.body);
			return true;
		},
	});

	return comments.map(({ location }) => {
		return { location, target: findTarget(statements, location.beginLine) };
	});
}

function contains(span: LuauSpan, { column, line }: TypeTestDiagnostic): boolean {
	const isAfterStart =
		line > span.beginLine || (line === span.beginLine && column >= span.beginColumn);
	const isBeforeEnd = line < span.endLine || (line === span.endLine && column < span.endColumn);
	return isAfterStart && isBeforeEnd;
}
