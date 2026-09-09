import type { LuauSpan } from "./ast.ts";
import { forEachCstNode, isCstNode, tokenBounds, walkCst } from "./cst.ts";
import type { CstNode } from "./cst.ts";

/**
 * Text printed in a node's place. The node's outer trivia stays on both
 * sides unless a switch says otherwise.
 */
export interface TextReplacement {
	preserveLeading?: boolean;
	preserveTrailing?: boolean;
	text: string;
}

/**
 * Nothing prints in the node's place. When the node held a whole line, its
 * indentation and newline go with it so no blank line is left; the comments
 * above it stay unless `preserveLeading` is off. A node sharing its line
 * keeps the whitespace on both sides.
 */
export interface Removal {
	preserveLeading: boolean;
	remove: true;
}

/**
 * What prints in a node's place: a subtree, text, or nothing. A subtree
 * keeps the node's outer trivia on both sides, and its origin-less tokens
 * take the origin of the node's first token so the sourcemap traces them
 * there.
 */
export type Replacement = CstNode | Removal | TextReplacement;

export interface ReplaceOptions {
	/** Named in the error when a second caller replaces the same node. */
	caller: string;
	replacement: Replacement;
	target: CstNode;
}

export interface RemoveOptions {
	caller: string;
	/** Whether the comments above the node survive. */
	preserveLeading: boolean;
	/** A statement, or a list item that goes with its separator. */
	statement: CstNode;
}

export interface RenameOptions {
	/** The new identifier. */
	name: string;
	/** The serializer's binding number. */
	binding: number;
}

/**
 * The replacements the printer consults before printing a node. Two callers
 * that replace the same node are a conflict, reported by both names.
 */
export interface CstEdits {
	/** Print nothing in the statement's place; see {@link Removal}. */
	remove: (options: RemoveOptions) => void;
	replace: (options: ReplaceOptions) => void;
	replacementFor: (node: CstNode) => Replacement | undefined;
}

interface Registered {
	caller: string;
	replacement: Replacement;
}

type Ledger = Map<CstNode, Registered>;

interface AnchorOptions {
	origin: LuauSpan;
	replacements: Ledger;
	subtree: CstNode;
}

/**
 * An empty ledger of replacements.
 *
 * @returns The ledger.
 */
export function createCstEdits(): CstEdits {
	const replacements: Ledger = new Map();

	function replace({ caller, replacement, target }: ReplaceOptions): void {
		const existing = replacements.get(target);
		if (existing !== undefined) {
			const { beginColumn, beginLine } = target.location;
			throw new Error(
				`${caller} cannot replace the ${target.type} at ${String(beginLine)}:${String(beginColumn)}: ${existing.caller} already replaced it`,
			);
		}

		// A target that is itself an unanchored subtree has no origin to give
		// yet; its own registration anchors both.
		const origin = tokenBounds(target)?.first.origin;
		if (origin !== undefined && isCstNode(replacement)) {
			anchor({ origin, replacements, subtree: replacement });
		}

		replacements.set(target, { caller, replacement });
	}

	return {
		remove: ({ caller, preserveLeading, statement }) => {
			replace({ caller, replacement: { preserveLeading, remove: true }, target: statement });
		},
		replace,
		replacementFor: (node) => replacements.get(node)?.replacement,
	};
}

/**
 * {@link renameBinding} for many bindings in one walk.
 *
 * @param root - The tree, or the subtree, to rename within.
 * @param names - The new name of each binding to rename.
 */
export function renameBindings(root: CstNode, names: ReadonlyMap<number, string>): void {
	forEachCstNode(root, (node) => {
		if (node.type === "LocalDecl" || node.type === "LocalRef") {
			node.name.text = names.get(node.binding) ?? node.name.text;
		}
	});
}

/**
 * Rename a binding: every declaration and reference sharing the binding gets
 * the new name. Identity, not text, selects the tokens, so a shadowing local
 * of the same name is untouched.
 *
 * @param root - The tree, or the subtree, to rename within.
 * @param options - The binding and its new name.
 */
export function renameBinding(root: CstNode, { name, binding }: RenameOptions): void {
	renameBindings(root, new Map([[binding, name]]));
}

/**
 * Give a subtree's origin-less tokens one origin, through any subtree already
 * registered to replace a node inside it.
 */
function anchor({ origin, replacements, subtree }: AnchorOptions): void {
	walkCst(subtree, {
		onNode: (node) => {
			const inner = replacements.get(node)?.replacement;
			if (inner !== undefined && isCstNode(inner)) {
				anchor({ origin, replacements, subtree: inner });
			}
		},
		onToken: (token) => {
			token.origin ??= origin;
		},
	});
}
