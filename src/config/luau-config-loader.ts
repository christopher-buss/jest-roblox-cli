import { type } from "arktype";
import * as path from "node:path";

import { evalLuauReturnLiterals, type LuauLiteralTable } from "../luau/eval-literals.ts";
import { luauParser } from "../luau/parser.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

const luauConfigTableSchema = type("object").as<LuauLiteralTable>();

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

	const result = luauConfigTableSchema(evalLuauReturnLiterals(parsed.root));
	if (result instanceof type.errors || Array.isArray(result)) {
		throw new Error(`Luau config ${filePath} must return a table`);
	}

	return result;
}

/**
 * Check if `<cwd>/<directoryOrFile>/jest.config.luau` exists. Returns the
 * resolved path if found, undefined otherwise.
 *
 * @param directoryOrFile - Project directory (or file) the config sits under.
 * @param cwd - Base directory for resolution.
 * @returns The resolved config path, or `undefined`.
 */
export function findLuauConfigFile(
	directoryOrFile: string,
	cwd: string,
	fileSystem: FileSystem = nodeFileSystem,
): string | undefined {
	const resolved = path.resolve(cwd, directoryOrFile, "jest.config.luau");
	if (fileSystem.existsSync(resolved)) {
		return resolved;
	}

	return undefined;
}
