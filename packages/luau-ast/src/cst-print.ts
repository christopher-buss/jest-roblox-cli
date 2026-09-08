import { forEachToken } from "./cst.ts";
import type { CstRoot } from "./cst.ts";

/**
 * Print a tree back to source: for each token in lexical order, its leading
 * trivia, its text, then its trailing trivia. A tree straight from the parser
 * prints byte-identical to its source.
 *
 * @param root - The tree to print.
 * @returns The printed source.
 */
export function printCst(root: CstRoot): string {
	let output = "";
	forEachToken(root, (token) => {
		for (const trivia of token.leading) {
			output += trivia.text;
		}

		output += token.text;
		for (const trivia of token.trailing) {
			output += trivia.text;
		}
	});

	return output;
}
