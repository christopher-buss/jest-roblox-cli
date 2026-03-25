import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { evalLuauReturnLiterals } from "../luau/eval-literals.ts";
import parseAstLuauSource from "../luau/parse-ast.luau";

let cachedTemporaryDirectory: string | undefined;

/**
 * Parse a .luau config file via Lute and evaluate its return expression.
 */
export function loadLuauConfig(filePath: string): Record<string, unknown> {
	const temporaryDirectory = getTemporaryDirectory();
	const scriptPath = path.join(temporaryDirectory, "parse-ast.luau");

	fs.writeFileSync(scriptPath, parseAstLuauSource);

	let stdout: string;
	try {
		stdout = cp.execFileSync("lute", ["run", scriptPath, "--", path.resolve(filePath)], {
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
		});
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			throw new Error(
				"lute is required to load .luau config files but was not found on PATH",
			);
		}

		throw new Error(`Failed to evaluate Luau config ${filePath}`, { cause: err });
	}

	let ast: JSONValue;
	try {
		ast = JSON.parse(stdout);
	} catch (err) {
		throw new Error(`Failed to parse AST JSON from Luau config ${filePath}`, { cause: err });
	}

	const result = evalLuauReturnLiterals(ast);
	if (typeof result !== "object" || result === null) {
		throw new Error(`Luau config ${filePath} must return a table`);
	}

	return result as Record<string, unknown>;
}

/**
 * Check if `<cwd>/<directoryOrFile>/jest.config.luau` exists. Returns the
 * resolved path if found, undefined otherwise.
 */
export function findLuauConfigFile(directoryOrFile: string, cwd: string): string | undefined {
	const resolved = path.resolve(cwd, directoryOrFile, "jest.config.luau");
	if (fs.existsSync(resolved)) {
		return resolved;
	}

	return undefined;
}

function getTemporaryDirectory(): string {
	if (cachedTemporaryDirectory !== undefined && fs.existsSync(cachedTemporaryDirectory)) {
		return cachedTemporaryDirectory;
	}

	cachedTemporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jest-roblox-luau-config-"));
	return cachedTemporaryDirectory;
}
