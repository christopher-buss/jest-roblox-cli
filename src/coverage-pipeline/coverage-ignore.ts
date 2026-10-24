import {
	BYTE_CARRIAGE_RETURN,
	BYTE_LINE_FEED,
	BYTE_SPACE,
	BYTE_TAB,
	indexSourceBytes,
} from "@isentinel/luau-ast";
import type { ByteRange, CommentSpan, ParseSuccess, SourceBytes } from "@isentinel/luau-ast";
import type { AstExprFunction, AstStat, AstStatIf, LuauSpan } from "@isentinel/luau-ast/ast";
import { visitBlock } from "@isentinel/luau-ast/visit";

/** Takes parser spans in UTF-8 bytes, so query it before `toUtf16Columns`. */
export interface CoverageIgnores {
	covers: (location: LuauSpan) => boolean;
	dropsImplicitElse: (node: AstStatIf) => boolean;
}

type DirectiveHint = "else" | "if" | "next";

interface Directive {
	hint: DirectiveHint;
	targetOffset: number;
}

interface Ignored {
	implicitElseDrops: Set<AstStatIf>;
	regions: Array<ByteRange>;
}

type IgnoreTarget = AstExprFunction | AstStat;

const DIRECTIVE = /^--(?:\[=*\[)?\s*cov\s+ignore\s+(\w+)/u;

const DIRECTIVE_HINTS: ReadonlySet<string> = new Set<DirectiveHint>(["else", "if", "next"]);

const NO_IGNORES = {
	covers: () => false,
	dropsImplicitElse: () => false,
} satisfies CoverageIgnores;

export function resolveCoverageIgnores(
	{ comments, root }: Pick<ParseSuccess, "comments" | "root">,
	source: string,
): CoverageIgnores {
	const bytes = indexSourceBytes(source);
	const directives = parseDirectives(comments, bytes);
	// Stryker disable next-line ConditionalExpression,BlockStatement: fast path
	if (directives.length === 0) {
		return NO_IGNORES;
	}

	const targets = indexTargets(root, bytes);
	const ignored: Ignored = { implicitElseDrops: new Set(), regions: [] };
	for (const { hint, targetOffset } of directives) {
		const target = targets.get(targetOffset);
		if (target === undefined) {
			continue;
		}

		if (hint === "next") {
			ignored.regions.push(bytes.spanToRange(target.location));
		} else if (target.type === "AstStatIf") {
			applyArmHint(target, { bytes, hint, ignored });
		}
	}

	return {
		covers: (location) => {
			const { end, start } = bytes.spanToRange(location);
			return ignored.regions.some((region) => region.start <= start && end <= region.end);
		},
		dropsImplicitElse: (node) => ignored.implicitElseDrops.has(node),
	};
}

function isDirectiveHint(value: string): value is DirectiveHint {
	return DIRECTIVE_HINTS.has(value);
}

function isBlank(byte: number | undefined): boolean {
	return (
		byte === BYTE_SPACE ||
		byte === BYTE_TAB ||
		byte === BYTE_LINE_FEED ||
		byte === BYTE_CARRIAGE_RETURN
	);
}

function skipTrivia(
	offset: number,
	{ bytes, commentEnds }: { bytes: SourceBytes; commentEnds: Map<number, number> },
): number {
	let cursor = offset;
	for (;;) {
		const commentEnd = commentEnds.get(cursor);
		if (commentEnd !== undefined) {
			cursor = commentEnd;
		} else if (isBlank(bytes.byteAt(cursor))) {
			cursor++;
		} else {
			return cursor;
		}
	}
}

function parseDirectives(comments: Array<CommentSpan>, bytes: SourceBytes): Array<Directive> {
	const commentEnds = new Map(
		comments.map(({ location }) => {
			const { end, start } = bytes.spanToRange(location);
			return [start, end];
		}),
	);

	return comments.flatMap(({ location }) => {
		const hint = DIRECTIVE.exec(bytes.sliceSpan(location))?.[1];
		if (hint === undefined || !isDirectiveHint(hint)) {
			return [];
		}

		const targetOffset = skipTrivia(bytes.spanToRange(location).end, { bytes, commentEnds });
		return [{ hint, targetOffset }];
	});
}

function applyArmHint(
	node: AstStatIf,
	{
		bytes,
		hint,
		ignored,
	}: { bytes: SourceBytes; hint: Exclude<DirectiveHint, "next">; ignored: Ignored },
): void {
	if (hint === "if") {
		ignored.regions.push(bytes.spanToRange(node.thenbody.location));
		return;
	}

	let last = node;
	while (last.elsebody?.type === "AstStatIf") {
		last = last.elsebody;
	}

	if (last.elsebody === undefined) {
		ignored.implicitElseDrops.add(node);
	} else {
		ignored.regions.push(bytes.spanToRange(last.elsebody.location));
	}
}

function indexTargets(root: ParseSuccess["root"], bytes: SourceBytes): Map<number, IgnoreTarget> {
	const targets = new Map<number, IgnoreTarget>();
	function add(node: IgnoreTarget): void {
		targets.set(bytes.spanToRange(node.location).start, node);
	}

	visitBlock(root, {
		visitExprFunction: (node) => {
			add(node);
			return true;
		},
		visitStatBlock: (block) => {
			for (const statement of block.body) {
				add(statement);
			}

			return true;
		},
	});

	return targets;
}
