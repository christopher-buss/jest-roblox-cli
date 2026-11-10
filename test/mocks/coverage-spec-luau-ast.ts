import type { AstStatBlock, LuauSpan } from "@isentinel/luau-ast/ast";
import { fromAny } from "@total-typescript/shoehorn";

import type { CoverageIgnores } from "#src/instrument/coverage-ignore.ts";

export const NO_IGNORES = {
	covers: () => false,
	dropsImplicitElse: () => false,
} satisfies CoverageIgnores;

export function span(line: number): LuauSpan {
	return { beginColumn: 1, beginLine: line, endColumn: 5, endLine: line };
}

export function block(line: number, body: Array<unknown> = []): AstStatBlock {
	return fromAny<AstStatBlock, unknown>({ body, location: span(line), type: "AstStatBlock" });
}
