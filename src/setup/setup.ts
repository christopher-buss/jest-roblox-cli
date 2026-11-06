import { type } from "arktype";
import * as path from "node:path";

import { LUAU_CONFIG_TYPE_SOURCE } from "../config/luau-config-type.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { addConfigLuauAlias, aliasEntry, type LuauAlias } from "./config-luau-alias.ts";

/** The first positional that runs setup instead of tests. */
export const SETUP_COMMAND = "setup";

const ALIAS_NAME = "jest-roblox";
const CONFIG_LUAU = ".config.luau";
const LUAURC = ".luaurc";

const INDENTATION = /^[\t ]+/m;

/** What setup wrote, and where. */
export type SetupOutcome = AliasWrite & {
	/** Folder that holds the Luau Config type module. */
	typesDirectory: string;
};

type AliasWrite =
	| { configFile: string; entry: string; kind: "manual" }
	| { configFile: string; entry: string; kind: "unreadable"; problem: string }
	| { configFile: string; kind: "created" | "edited" };

type LuaurcRead = { luaurc: typeof luaurcSchema.infer; ok: true } | { ok: false; problem: string };

type PrintableOutcome = Exclude<SetupOutcome, { kind: "unreadable" }>;

interface SetupOptions {
	cwd: string;
	fileSystem: FileSystem;
	homeDirectory: string;
	version: string;
}

const luaurcSchema = type({
	"+": "ignore",
	"aliases?": "Record<string, string>",
});

/**
 * Write the Luau Config type module to the versioned home folder and add the
 * `jest-roblox` alias to the project's Luau configuration.
 * @param options - Working directory, file system, home folder and version.
 * @returns What setup wrote, and where.
 */
export function runSetup({ cwd, fileSystem, homeDirectory, version }: SetupOptions): SetupOutcome {
	const typesDirectory = path.join(homeDirectory, ".jest-roblox", "typedefs", version);
	fileSystem.mkdirSync(typesDirectory, { recursive: true });
	fileSystem.writeFileSync(path.join(typesDirectory, "config.luau"), LUAU_CONFIG_TYPE_SOURCE);

	const alias = { name: ALIAS_NAME, value: `~/.jest-roblox/typedefs/${version}` };
	return { ...writeAlias({ alias, cwd, fileSystem }), typesDirectory };
}

/**
 * Format a setup outcome for the terminal.
 * @param outcome - A setup outcome that is not `unreadable`.
 * @returns The report, ending with a newline.
 */
export function formatSetupOutcome(outcome: PrintableOutcome): string {
	const lines = [`Wrote the Luau Config type to ${outcome.typesDirectory}`];
	if (outcome.kind === "manual") {
		lines.push(
			`${outcome.configFile} builds luau.aliases with code, so setup left it unchanged.`,
			"Add this entry to luau.aliases:",
			"",
			`\t${outcome.entry},`,
			"",
		);
	} else {
		const verb = outcome.kind === "created" ? "Created" : "Updated";
		lines.push(`${verb} ${outcome.configFile} with the "${ALIAS_NAME}" alias`);
	}

	lines.push(`Type your config with: local jest = require("@${ALIAS_NAME}/config")`);
	return `${lines.join("\n")}\n`;
}

function createdConfigLuau(alias: LuauAlias): string {
	return `return {\n\tluau = {\n\t\taliases = {\n\t\t\t${aliasEntry(alias)},\n\t\t},\n\t},\n}\n`;
}

function luaurcEntry(alias: LuauAlias): string {
	return `${JSON.stringify(alias.name)}: ${JSON.stringify(alias.value)}`;
}

function readLuaurc(source: string): LuaurcRead {
	let json: JSONValue;
	try {
		json = JSON.parse(source);
	} catch (err) {
		return {
			ok: false,
			problem: `it is not strict JSON (${errorMessage(err)}). Setup cannot read comments or trailing commas`,
		};
	}

	const parsed = luaurcSchema(json);
	if (parsed instanceof type.errors) {
		return { ok: false, problem: parsed.summary };
	}

	return { luaurc: parsed, ok: true };
}

function mergeLuaurcAlias({
	alias,
	luaurc,
	source,
}: {
	alias: LuauAlias;
	luaurc: typeof luaurcSchema.infer;
	source: string;
}): string {
	const aliases = Object.fromEntries(
		Object.entries(luaurc.aliases ?? {}).filter(
			([name]) => name.toLowerCase() !== alias.name.toLowerCase(),
		),
	);
	const indent = INDENTATION.exec(source)?.[0] ?? "\t";
	const merged = { ...luaurc, aliases: { ...aliases, [alias.name]: alias.value } };
	return `${JSON.stringify(merged, undefined, indent)}\n`;
}

function writeLuaurcAlias({
	alias,
	fileSystem,
	luaurcPath,
}: {
	alias: LuauAlias;
	fileSystem: FileSystem;
	luaurcPath: string;
}): AliasWrite {
	const source = fileSystem.readFileSync(luaurcPath, "utf-8");
	const read = readLuaurc(source);
	if (!read.ok) {
		return {
			configFile: LUAURC,
			entry: luaurcEntry(alias),
			kind: "unreadable",
			problem: read.problem,
		};
	}

	fileSystem.writeFileSync(luaurcPath, mergeLuaurcAlias({ alias, luaurc: read.luaurc, source }));
	return { configFile: LUAURC, kind: "edited" };
}

function writeAlias({
	alias,
	cwd,
	fileSystem,
}: {
	alias: LuauAlias;
	cwd: string;
	fileSystem: FileSystem;
}): AliasWrite {
	const configLuauPath = path.join(cwd, CONFIG_LUAU);
	if (fileSystem.existsSync(configLuauPath)) {
		const edit = addConfigLuauAlias({
			alias,
			fileName: configLuauPath,
			source: fileSystem.readFileSync(configLuauPath, "utf-8"),
		});
		if (edit.kind === "computed") {
			return { configFile: CONFIG_LUAU, entry: aliasEntry(alias), kind: "manual" };
		}

		fileSystem.writeFileSync(configLuauPath, edit.source);
		return { configFile: CONFIG_LUAU, kind: "edited" };
	}

	const luaurcPath = path.join(cwd, LUAURC);
	if (fileSystem.existsSync(luaurcPath)) {
		return writeLuaurcAlias({ alias, fileSystem, luaurcPath });
	}

	fileSystem.writeFileSync(configLuauPath, createdConfigLuau(alias));
	return { configFile: CONFIG_LUAU, kind: "created" };
}
