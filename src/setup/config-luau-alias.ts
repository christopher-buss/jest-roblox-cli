import { decodeLuauString, printCst, tokenBounds } from "@isentinel/luau-ast";
import type {
	CstNode,
	CstRoot,
	CstTable,
	CstTableItem,
	Token,
	Trivia,
} from "@isentinel/luau-ast/cst";

import assert from "node:assert";

import { luauParser } from "../luau/parser.ts";

/** One entry of a Luau `aliases` table. */
export interface LuauAlias {
	/** Alias name, written without the leading `@`. */
	readonly name: string;
	/** Path the alias resolves to. */
	readonly value: string;
}

/** Result of an attempt to add an alias to a `.config.luau` source. */
export type ConfigLuauAliasEdit =
	| {
			/** `luau.aliases` is built by code, so no edit is possible. */
			kind: "computed";
	  }
	| {
			/** The alias is in the table. */
			kind: "edited";
			/** The edited source, with its comments and formatting kept. */
			source: string;
	  };

const ALIAS_TABLE_PATH = ["luau", "aliases"] as const;

/**
 * Format an alias as a Luau table entry.
 * @param alias - The alias to format.
 * @returns The entry, without a trailing comma.
 */
export function aliasEntry(alias: LuauAlias): string {
	return `[${quote(alias.name)}] = ${quote(alias.value)}`;
}

/**
 * Add an alias to the `luau.aliases` table of a `.config.luau` source with a
 * CST edit.
 * @param options - The alias, and the file name and source to edit.
 * @returns The edited source, or `computed` when code builds the table.
 */
export function addConfigLuauAlias({
	alias,
	fileName,
	source,
}: {
	/** The alias to add. */
	alias: LuauAlias;
	/** File name for parse errors. */
	fileName: string;
	/** The `.config.luau` source. */
	source: string;
}): ConfigLuauAliasEdit {
	const parsed = luauParser.parseCst({ fileName, source });
	if (!parsed.ok) {
		throw new Error(`Failed to parse ${fileName}: ${parsed.errors.join("; ")}`);
	}

	let table = returnedTable(parsed.root);
	if (table === undefined) {
		return { kind: "computed" };
	}

	for (const [depth, key] of ALIAS_TABLE_PATH.entries()) {
		const item = findItem(table, key);
		if (item === undefined) {
			appendItem(table, constructItem(nestedEntry(ALIAS_TABLE_PATH.slice(depth), alias)));
			return { kind: "edited", source: printCst(parsed.root) };
		}

		if (item.value.type !== "Table") {
			return { kind: "computed" };
		}

		table = item.value;
	}

	const existing = findItem(table, alias.name);
	if (existing === undefined) {
		appendItem(table, constructItem(aliasEntry(alias)));
	} else if (existing.value.type === "String") {
		existing.value.token.text = quote(alias.value);
	} else {
		return { kind: "computed" };
	}

	return { kind: "edited", source: printCst(parsed.root) };
}

function quote(text: string): string {
	return JSON.stringify(text);
}

function nestedEntry(keys: ReadonlyArray<string>, alias: LuauAlias): string {
	return keys.reduceRight((inner, key) => `${key} = { ${inner} }`, aliasEntry(alias));
}

function returnedTable(root: CstRoot): CstTable | undefined {
	const statement = root.body.body.find(({ type }) => type === "Return");
	if (statement?.type !== "Return") {
		return undefined;
	}

	const value = statement.values[0]?.node;
	return value?.type === "Table" ? value : undefined;
}

function itemKey(item: CstTableItem): string | undefined {
	if (item.key?.type !== "String") {
		return undefined;
	}

	const { text } = item.key.token;
	return item.open === undefined ? text : decodeLuauString(text);
}

function findItem(table: CstTable, key: string): CstTableItem | undefined {
	const wanted = key.toLowerCase();
	return table.items.find((item) => itemKey(item)?.toLowerCase() === wanted);
}

function bounds(node: CstNode): { first: Token; last: Token } {
	const found = tokenBounds(node);
	assert(found !== undefined, "A table entry holds no tokens");
	return found;
}

function constructItem(entry: string): CstTableItem {
	const table = luauParser.constructExpression(`{ ${entry} }`);
	assert(table.type === "Table", `Expected a table: ${entry}`);
	const [item] = table.items;
	assert(item !== undefined, `Expected a table entry: ${entry}`);

	const { first, last } = bounds(item);
	first.leading = [];
	last.trailing = [];
	return item;
}

function whitespace(text: string): Trivia {
	return { kind: "whitespace", text };
}

function indentation(trivia: ReadonlyArray<Trivia>): string {
	const last = trivia.at(-1);
	if (last?.kind !== "whitespace") {
		return "";
	}

	return last.text.slice(last.text.lastIndexOf("\n") + 1);
}

function separatorAfter(item: CstTableItem): Token {
	if (item.separator !== undefined) {
		return item.separator;
	}

	const { last } = bounds(item.value);
	const separator: Token = { leading: [], text: ",", trailing: last.trailing };
	last.trailing = [];
	item.separator = separator;
	return separator;
}

function fillEmptyTable(table: CstTable, item: CstTableItem): void {
	const { first, last } = bounds(item);
	const { close, open } = table;
	if (open.trailing.some(({ text }) => text.includes("\n"))) {
		first.leading = [whitespace(`${indentation(close.leading)}\t`)];
		item.separator = { leading: [], text: ",", trailing: open.trailing.slice(-1) };
	} else {
		first.leading = open.trailing.length === 0 ? [whitespace(" ")] : [];
		last.trailing = [whitespace(" ")];
	}

	table.items.push(item);
}

function appendItem(table: CstTable, item: CstTableItem): void {
	const previous = table.items.at(-1);
	if (previous === undefined) {
		fillEmptyTable(table, item);
		return;
	}

	const hasTrailingComma = previous.separator !== undefined;
	const closing = separatorAfter(previous).trailing.slice(-1);
	const { first, last } = bounds(item);
	first.leading = [whitespace(indentation(bounds(previous).first.leading))];
	if (hasTrailingComma) {
		item.separator = { leading: [], text: ",", trailing: closing };
	} else {
		last.trailing = closing;
	}

	table.items.push(item);
}
