import type {
	AstExpr,
	AstExprFunction,
	AstStatBlock,
	AstStatFunction,
	AstStatLocalFunction,
} from "@isentinel/luau-ast/ast";
import type { LuauVisitor } from "@isentinel/luau-ast/visit";

import type { CoverageAccumulator, SourcePosition } from "./coverage-accumulator.ts";
import type { CoverageIgnores } from "./coverage-ignore.ts";

interface NamedFunctionContext {
	readonly accumulator: CoverageAccumulator;
	readonly ignores: CoverageIgnores;
	readonly namedFunctions: Set<AstExprFunction>;
}

/**
 * Locate where a function body starts.
 * @param block - Function body.
 * @returns Start of the first statement, or of the block when it is empty.
 */
export function getBodyFirstStatement(block: AstStatBlock): SourcePosition {
	const first = block.body[0];
	if (first !== undefined) {
		return { column: first.location.beginColumn, line: first.location.beginLine };
	}

	return { column: block.location.beginColumn, line: block.location.beginLine };
}

/**
 * Record each named and anonymous function once, skipping ignored spans.
 * @param accumulator - Receives the function records.
 * @param ignores - Spans excluded from coverage.
 * @returns Visitor hooks that collect functions.
 */
export function createFunctionCollector(
	accumulator: CoverageAccumulator,
	ignores: CoverageIgnores,
): Partial<LuauVisitor> {
	// Else the expression visitor counts a named body again as `(anonymous)`.
	const namedFunctions = new Set<AstExprFunction>();

	const context = { accumulator, ignores, namedFunctions };

	return {
		visitExprFunction(node: AstExprFunction): boolean {
			if (namedFunctions.has(node) || ignores.covers(node.location)) {
				return true;
			}

			const first = getBodyFirstStatement(node.body);
			accumulator.addFunction({ name: "(anonymous)", location: node.location, start: first });

			return true;
		},

		visitStatFunction(node: AstStatFunction): boolean {
			addNamedFunction(context, { name: extractFunctionName(node), node });

			return true;
		},

		visitStatLocalFunction(node: AstStatLocalFunction): boolean {
			addNamedFunction(context, { name: node.name.name, node });

			return true;
		},
	};
}

function addNamedFunction(
	{ accumulator, ignores, namedFunctions }: NamedFunctionContext,
	{ name, node }: { name: string; node: AstStatFunction | AstStatLocalFunction },
): void {
	if (ignores.covers(node.location)) {
		return;
	}

	namedFunctions.add(node.func);
	const start = getBodyFirstStatement(node.func.body);
	accumulator.addFunction({ name, location: node.location, start });
}

function extractExprName(expr: AstExpr): string {
	if (expr.type === "AstExprGlobal") {
		return expr.global;
	}

	if (expr.type === "AstExprIndexName") {
		const object = extractExprName(expr.expr);
		return `${object}${expr.op}${expr.index}`;
	}

	return "(anonymous)";
}

function extractFunctionName(node: AstStatFunction): string {
	return extractExprName(node.name);
}
