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
import { configSchema } from "./config-validation.ts";
import type { LuteEvaluationContext } from "./luau-config-lute.ts";
import { evaluateLuauConfigWithLute, NODE_LUTE_EVALUATION_CONTEXT } from "./luau-config-lute.ts";

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
 * Read a Luau Config statically, or run it with lute when it holds code.
 *
 * @param filePath - Path to the config file.
 * @param context - File system and lute collaborators; each defaults to the
 *   real one.
 * @returns The evaluated config table.
 * @rejects If the file does not parse, lute fails or the value is not a
 *   table.
 */
export async function loadLuauConfig(
	filePath: string,
	context: Partial<LuteEvaluationContext>,
): Promise<LuauLiteralTable> {
	const settled = { ...NODE_LUTE_EVALUATION_CONTEXT, ...context };
	const configFile = path.resolve(filePath);
	const source = settled.fileSystem.readFileSync(configFile, "utf-8");
	const parsed = luauParser.parse(source);
	if (!parsed.ok) {
		throw new Error(`Failed to evaluate Luau config ${filePath}: ${parsed.errors.join("; ")}`);
	}

	const evaluation = evalLuauReturnLiterals(parsed.root);
	const value =
		evaluation.kind === "value"
			? evaluation.value
			: await evaluateLuauConfigWithLute({ configFile, unreadable: evaluation }, settled);

	return toConfigTable(value, filePath);
}

/**
 * Check if `<cwd>/<directoryOrFile>/jest.config.luau` exists. Returns the
 * resolved path if found, undefined otherwise.
 *
 * @param options - Base directory, project directory (or file) the config
 *   sits under, and the file system to check.
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

function toConfigTable(value: LuauLiteral, filePath: string): LuauLiteralTable {
	const result = luauConfigTableSchema(value);
	if (result instanceof type.errors || Array.isArray(result)) {
		throw new Error(`Luau config ${filePath} must return a table`);
	}

	return normalizeEmptyLists(result);
}
