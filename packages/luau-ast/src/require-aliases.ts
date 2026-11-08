import { type } from "arktype";
import path from "node:path";

import type { CstExpr, CstRoot, CstTable } from "./cst.ts";
import type { LuauParser } from "./parser.ts";
import { decodeLuauString } from "./string-literal.ts";

/** The file reads that require resolution makes. */
export interface RequireFileSystem {
	/** Whether a file is there. */
	existsSync: (filePath: string) => boolean;
	/** A file's text. */
	readFileSync: (filePath: string, encoding: "utf-8") => string;
}

/** Where an alias points, or why the lookup could not say. */
export type AliasLookup =
	| { kind: "found"; path: string }
	| { kind: "invalid"; reason: string }
	| { kind: "missing" };

type AliasTable =
	| { aliases: ReadonlyMap<string, string>; ok: true }
	| { ok: false; reason: string };

const CONFIG_FILES = [".config.luau", ".luaurc"] as const;

const luaurcSchema = type("string.json.parse").to({
	"+": "ignore",
	"aliases?": "Record<string, string>",
});

/**
 * Restate a path with forward slashes, the form every resolved path takes.
 *
 * @param value - A path in either separator style.
 * @returns The path with forward slashes.
 */
export function toPosix(value: string): string {
	return value.replaceAll("\\", "/");
}

/**
 * Build an alias lookup over the Luau configuration files. From a directory
 * up to the root, the first directory whose configuration names the alias
 * wins. A directory holds at most one of `.config.luau` and `.luaurc`; a
 * directory with both is ambiguous. Alias names match without regard to case,
 * and a relative alias path is relative to the directory of the file that
 * names it.
 *
 * @param options - The file system and the parser for `.config.luau`.
 * @returns A lookup from a starting directory and an alias name.
 */
export function createAliasLookup(options: {
	fileSystem: RequireFileSystem;
	parser: LuauParser;
}): (input: { directory: string; name: string }) => AliasLookup {
	const tables = new Map<string, AliasTable | undefined>();
	function readCached(directory: string): AliasTable | undefined {
		if (!tables.has(directory)) {
			tables.set(directory, readDirectoryAliases({ ...options, directory }));
		}

		return tables.get(directory);
	}

	return ({ name, directory }) => {
		const wanted = name.toLowerCase();
		for (const current of ancestors(directory)) {
			const table = readCached(current);
			if (table?.ok === false) {
				return { kind: "invalid", reason: table.reason };
			}

			const target = table?.aliases.get(wanted);
			if (target !== undefined) {
				return { kind: "found", path: resolveAliasPath(current, target) };
			}
		}

		return { kind: "missing" };
	};
}

function ancestors(directory: string): Array<string> {
	const directories = [directory];
	let parent = toPosix(path.dirname(directory));
	while (parent !== directories.at(-1)) {
		directories.push(parent);
		parent = toPosix(path.dirname(parent));
	}

	return directories;
}

function resolveAliasPath(directory: string, target: string): string {
	return path.isAbsolute(target) ? toPosix(target) : toPosix(path.join(directory, target));
}

function lowercaseKeys(entries: Iterable<[string, string]>): ReadonlyMap<string, string> {
	return new Map(Array.from(entries, ([name, target]) => [name.toLowerCase(), target]));
}

function readLuaurc({ filePath, source }: { filePath: string; source: string }): AliasTable {
	const parsed = luaurcSchema(source);
	if (parsed instanceof type.errors) {
		return { ok: false, reason: `${filePath} is not a valid .luaurc: ${parsed.summary}` };
	}

	return { aliases: lowercaseKeys(Object.entries(parsed.aliases ?? {})), ok: true };
}

function tableKey(item: CstTable["items"][number]): string | undefined {
	if (item.key?.type !== "String") {
		return undefined;
	}

	const { text } = item.key.token;
	return item.open === undefined ? text : decodeLuauString(text);
}

function field(table: CstTable, key: string): CstExpr | undefined {
	return table.items.find((item) => tableKey(item) === key)?.value;
}

function returnedTable(root: CstRoot): CstTable | undefined {
	const statement = root.body.body.find(({ type: kind }) => kind === "Return");
	const value = statement?.type === "Return" ? statement.values[0]?.node : undefined;
	return value?.type === "Table" ? value : undefined;
}

function readAliasEntries(table: CstTable): Array<[string, string]> | undefined {
	const entries: Array<[string, string]> = [];
	for (const item of table.items) {
		const name = tableKey(item);
		if (name === undefined || item.value.type !== "String") {
			return undefined;
		}

		entries.push([name, decodeLuauString(item.value.token.text)]);
	}

	return entries;
}

function readConfigLuau(input: {
	filePath: string;
	parser: LuauParser;
	source: string;
}): AliasTable {
	const notStatic = {
		ok: false,
		reason: `${input.filePath} does not hold luau.aliases as a table of strings`,
	} satisfies AliasTable;
	const parsed = input.parser.parseCst({ fileName: input.filePath, source: input.source });
	if (!parsed.ok) {
		return {
			ok: false,
			reason: `${input.filePath} does not parse: ${parsed.errors.join("; ")}`,
		};
	}

	const root = returnedTable(parsed.root);
	if (root === undefined) {
		return notStatic;
	}

	const luau = field(root, "luau");
	if (luau !== undefined && luau.type !== "Table") {
		return notStatic;
	}

	const aliases = luau === undefined ? undefined : field(luau, "aliases");
	if (aliases === undefined) {
		return { aliases: new Map(), ok: true };
	}

	const entries = aliases.type === "Table" ? readAliasEntries(aliases) : undefined;
	return entries === undefined ? notStatic : { aliases: lowercaseKeys(entries), ok: true };
}

function readAliasTable(input: {
	filePath: string;
	fileSystem: RequireFileSystem;
	parser: LuauParser;
}): AliasTable {
	let source: string;
	try {
		source = input.fileSystem.readFileSync(input.filePath, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `${input.filePath} cannot be read: ${message}` };
	}

	return input.filePath.endsWith(".luaurc")
		? readLuaurc({ filePath: input.filePath, source })
		: readConfigLuau({ ...input, source });
}

function readDirectoryAliases(input: {
	directory: string;
	fileSystem: RequireFileSystem;
	parser: LuauParser;
}): AliasTable | undefined {
	const [filePath, other] = CONFIG_FILES.map((fileName) => {
		return toPosix(path.join(input.directory, fileName));
	}).filter((candidate) => input.fileSystem.existsSync(candidate));
	if (other !== undefined) {
		return {
			ok: false,
			reason: `${input.directory} holds both .config.luau and .luaurc, so its aliases are ambiguous`,
		};
	}

	return filePath === undefined ? undefined : readAliasTable({ ...input, filePath });
}
