import { type } from "arktype";
import * as path from "node:path";

import { LUAU_CONFIG_TYPES_FOLDERS, writeLuauConfigTypes } from "../config/luau-config-type.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	addConfigLuauAlias,
	aliasEntry,
	type LuauAlias,
	readConfigLuauAlias,
} from "./config-luau-alias.ts";

/** The first positional that runs setup instead of tests. */
export const SETUP_COMMAND = "setup";

const ALIAS_NAME = "jest-roblox";
const CONFIG_LUAU = ".config.luau";
const LUAURC = ".luaurc";

const INDENTATION = /^[\t ]+/m;
const SEPARATOR = String.raw`[/\\]`;
const TYPES_FOLDERS = LUAU_CONFIG_TYPES_FOLDERS.map(
	(folder) => `${SEPARATOR}${RegExp.escape(folder)}`,
).join("");
const TYPES_VERSION = new RegExp(`${TYPES_FOLDERS}${SEPARATOR}([^/\\\\]+)${SEPARATOR}?$`);

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

interface ProjectAlias {
	configFile: string;
	value: string;
}

interface ProjectOptions {
	cwd: string;
	fileSystem: FileSystem;
	version: string;
}

interface SetupOptions extends ProjectOptions {
	homeDirectory: string;
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
	const typesDirectory = writeLuauConfigTypes({ fileSystem, homeDirectory, version });
	const alias = {
		name: ALIAS_NAME,
		value: ["~", ...LUAU_CONFIG_TYPES_FOLDERS, version].join("/"),
	};
	return { ...writeAlias({ alias, cwd, fileSystem }), typesDirectory };
}

/**
 * Warn when the project's `jest-roblox` alias points at the type folder of
 * another CLI version.
 * @param options - Working directory, file system and running version.
 * @returns The warning, ending with a newline, or `undefined`.
 */
export function aliasVersionWarning({
	cwd,
	fileSystem,
	version,
}: ProjectOptions): string | undefined {
	const alias = readProjectAlias({ cwd, fileSystem });
	const aliased = alias === undefined ? undefined : TYPES_VERSION.exec(alias.value)?.[1];
	if (alias === undefined || aliased === undefined || aliased === version) {
		return undefined;
	}

	return `Warning: the "${ALIAS_NAME}" alias in ${alias.configFile} points at the Luau Config type for jest-roblox ${aliased}, but this is jest-roblox ${version}. Run \`jest-roblox setup\` to update it.\n`;
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

function readOptionalFile(fileSystem: FileSystem, file: string): string | undefined {
	try {
		return fileSystem.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

function readProjectAlias({
	cwd,
	fileSystem,
}: {
	cwd: string;
	fileSystem: FileSystem;
}): ProjectAlias | undefined {
	const configLuauPath = path.join(cwd, CONFIG_LUAU);
	if (fileSystem.existsSync(configLuauPath)) {
		const source = readOptionalFile(fileSystem, configLuauPath);
		const value =
			source === undefined
				? undefined
				: readConfigLuauAlias({ name: ALIAS_NAME, fileName: configLuauPath, source });
		return value === undefined ? undefined : { configFile: CONFIG_LUAU, value };
	}

	const source = readOptionalFile(fileSystem, path.join(cwd, LUAURC));
	const read = source === undefined ? undefined : readLuaurc(source);
	const value =
		read === undefined || !read.ok
			? undefined
			: Object.entries(read.luaurc.aliases ?? {}).find(
					([name]) => name.toLowerCase() === ALIAS_NAME,
				)?.[1];
	return value === undefined ? undefined : { configFile: LUAURC, value };
}
