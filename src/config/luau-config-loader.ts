import { type } from "arktype";
import * as path from "node:path";

import {
	evalLuauReturnLiterals,
	type LuauLiteral,
	type LuauLiteralTable,
} from "../luau/eval-literals.ts";
import { luauParser } from "../luau/parser.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { configSchema } from "./schema.ts";

const luauConfigTableSchema = type("object").as<LuauLiteralTable>();
const testConfigSchema = configSchema.get("test").exclude("undefined");
const ARRAY_CONFIG_KEYS: ReadonlySet<string> = new Set(
	[
		...configSchema.props,
		...testConfigSchema.props,
		...configSchema.get("workspace").exclude("undefined").props,
	]
		.filter(({ value }) => value.allows([]) && !value.allows({}))
		.map(({ key }) => key),
);

/**
 * Parse a .luau config file in process and evaluate its return expression.
 *
 * @param filePath - Path to the config file.
 * @returns The evaluated config table.
 */
export function loadLuauConfig(
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): LuauLiteralTable {
	const source = fileSystem.readFileSync(path.resolve(filePath), "utf-8");
	const parsed = luauParser.parse(source);
	if (!parsed.ok) {
		throw new Error(`Failed to evaluate Luau config ${filePath}: ${parsed.errors.join("; ")}`);
	}

	const evaluation = evalLuauReturnLiterals(parsed.root);
	if (evaluation.kind === "unreadable") {
		throw new Error(
			`Luau config ${filePath}:${evaluation.line} holds ${evaluation.syntax}, which a plain-data Luau config cannot hold. Use only literals, tables, \`::\` casts and defineConfig(...).`,
		);
	}

	const result = luauConfigTableSchema(evaluation.value);
	if (result instanceof type.errors || Array.isArray(result)) {
		throw new Error(`Luau config ${filePath} must return a table`);
	}

	return normalizeEmptyLists(result);
}

/**
 * Check if `<cwd>/<directoryOrFile>/jest.config.luau` exists. Returns the
 * resolved path if found, undefined otherwise.
 *
 * @param directoryOrFile - Project directory (or file) the config sits under.
 * @param cwd - Base directory for resolution.
 * @returns The resolved config path, or `undefined`.
 */
export function findLuauConfigFile({
	cwd,
	directoryOrFile,
	fileSystem = nodeFileSystem,
}: {
	readonly cwd: string;
	readonly directoryOrFile: string;
	readonly fileSystem?: FileSystem;
}): string | undefined {
	const resolved = path.resolve(cwd, directoryOrFile, "jest.config.luau");
	if (fileSystem.existsSync(resolved)) {
		return resolved;
	}

	return undefined;
}

function isLiteralTable(value: LuauLiteral): value is LuauLiteralTable {
	return typeof value === "object" && !Array.isArray(value);
}

function normalizeEmptyLists(table: LuauLiteralTable): LuauLiteralTable {
	for (const [key, value] of Object.entries(table)) {
		if (
			isLiteralTable(value) &&
			Object.keys(value).length === 0 &&
			ARRAY_CONFIG_KEYS.has(key)
		) {
			table[key] = [];
		}
	}

	for (const key of ["test", "typecheck", "workspace"]) {
		const value = table[key];
		if (isLiteralTable(value)) {
			normalizeEmptyLists(value);
		}
	}

	const { projects } = table;
	if (Array.isArray(projects)) {
		for (const project of projects) {
			if (isLiteralTable(project)) {
				normalizeEmptyLists(project);
			}
		}
	}

	return table;
}
