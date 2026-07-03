import { loadConfig as c12LoadConfig } from "c12";
import { defuFn } from "defu";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG, validateConfig } from "./schema.ts";

export function applySnapshotFormatDefaults(
	config: ResolvedConfig,
	isLuauProject: boolean,
): ResolvedConfig {
	if (config.snapshotFormat?.printBasicPrototype !== undefined) {
		return config;
	}

	return {
		...config,
		snapshotFormat: {
			...config.snapshotFormat,
			printBasicPrototype: isLuauProject,
		},
	};
}

export function resolveConfig(config: Config): ResolvedConfig {
	validateConfig(config);

	const { test, ...rest } = config;
	const definedRest = Object.fromEntries(
		Object.entries(rest).filter(([, value]) => value !== undefined),
	);
	const definedTest =
		test === undefined
			? {}
			: Object.fromEntries(Object.entries(test).filter(([, value]) => value !== undefined));

	// Flatten test: block onto resolved config so downstream consumers
	// (executor, projects, test-script, formatters) see jest options at the
	// top level. TODO: refactor consumers to read `config.test.*` directly.
	const resolved: ResolvedConfig = { ...DEFAULT_CONFIG, ...definedTest, ...definedRest };

	// `gameOutput: true` / `outputFile: true` are shorthand for the
	// conventional `game-output.log` / `jest-output.log` under the root.
	// Expand here so downstream consumers only ever see a path string.
	if (config.gameOutput === true) {
		resolved.gameOutput = path.join(resolved.rootDir, "game-output.log");
	}

	if (config.outputFile === true) {
		resolved.outputFile = path.join(resolved.rootDir, "jest-output.log");
	}

	return resolved;
}

/**
 * Load the user-declared config without merging `DEFAULT_CONFIG`. Returned
 * fields are exactly what the user wrote — omitted fields stay `undefined`.
 * Use this when downstream code must distinguish "user declared X=false" from
 * "X defaulted to false" (e.g. workspace consensus checks).
 *
 * The config is validated (same schema check as `loadConfig`) so workspace
 * mode rejects malformed per-package configs with the same error messaging,
 * rather than comparing unchecked shapes and failing later.
 */
export async function loadRawConfig(
	configPath?: string,
	cwd: string = process.cwd(),
): Promise<Config> {
	let result;
	try {
		result = await invokeC12(configPath, cwd);
	} catch (err) {
		if (configPath !== undefined && isC12NotFoundError(err)) {
			throw new Error(`Config file not found: ${configPath}`, { cause: err });
		}

		throw err;
	}

	const mergedConfig = await processExtends(result, new Set());

	return validateConfig(resolveFunctionValues(mergedConfig));
}

export async function loadConfig(
	configPath?: string,
	cwd: string = process.cwd(),
): Promise<ResolvedConfig> {
	const config = await loadRawConfig(configPath, cwd);
	config.rootDir ??= cwd;

	return resolveConfig(config);
}

// c12 signals an unresolvable required config file with this message shape.
// Other failures (parse errors, import-time exceptions) surface unchanged.
function isC12NotFoundError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("cannot be resolved");
}

function isSea(): boolean {
	return process.env["JEST_ROBLOX_SEA"] === "true";
}

// A SEA binary's ESM loader can't `import()` a file off disk — Node routes every
// dynamic import through the single-executable's built-in resolver, so any path
// fails (`No such built-in module` / `ERR_UNKNOWN_BUILTIN_MODULE`). `require()`
// is unaffected, and Node's `require` handles everything a config needs:
// TypeScript type-stripping for `.ts`/`.mts`/`.cts`, ESM `export default`
// (returned as `{ default }`), and bare-specifier resolution from the project's
// on-disk `node_modules`. Anchoring the require at the config path lets a config
// that imports a runtime value (e.g. `defineConfig` from
// `@isentinel/jest-roblox`) resolve it relative to itself; a genuinely
// unresolvable import surfaces Node's standard module-resolution error. `.json`
// keeps its read + parse path (a bare `require` of JSON works too, but reading
// avoids relying on CJS JSON-module semantics).
async function seaImport(id: string): Promise<JSONValue> {
	if (id.endsWith(".json")) {
		const content = readFileSync(id, "utf-8");
		return JSON.parse(content);
	}

	return createRequire(id)(id) as JSONValue;
}

// c12's merger signature and defuFn's generic signature are structurally
// incompatible. This wrapper bridges the two with a single boundary cast.
function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn(...(sources.filter(Boolean) as [Config, ...Array<Config>]));
}

async function invokeC12(configFile: string | undefined, cwd: string) {
	return c12LoadConfig<Config>({
		name: "jest",
		configFile,
		configFileRequired: configFile !== undefined,
		cwd,
		dotenv: false,
		extend: false,
		globalRc: false,
		// In SEA mode, jiti's babel.cjs can't be resolved from the
		// single-executable archive. Bypass jiti entirely by providing a
		// custom import function.
		import: isSea() ? seaImport : undefined,
		merger,
		omit$Keys: true,
		packageJson: false,
		rcFile: false,
	});
}

// `workspace.root` is relative in source; anchor it to the directory of the
// file that declares it (typically a shared config reached via `extends:`) so
// the workspace root stays stable regardless of which package directory the CLI
// runs from. Applied per-layer before merge — once layers merge, the declaring
// file's directory is no longer recoverable.
function anchorWorkspaceRoot(config: Config, baseDirectory: string): Config {
	const { workspace } = config;
	if (workspace?.root === undefined || path.isAbsolute(workspace.root)) {
		return config;
	}

	return {
		...config,
		workspace: { ...workspace, root: path.resolve(baseDirectory, workspace.root) },
	};
}

// c12 mis-resolves relative `extends` paths whose `dirname()` is non-empty
// (e.g. "../../jest.shared.ts"): it adds dirname(source) to its internal cwd
// but leaves source unchanged, then re-applies dirname when resolving the file
// — duplicating the path component. See c12 issue #57. We disable c12's extend
// handling and resolve the chain ourselves against the loaded config file's
// actual directory.
//
// `visited` is stack-local — popped on unwind via `finally` — so a diamond
// graph (child → [a, b], both → base) loads `base` twice rather than failing
// as a false cycle. Config load is one-time at startup; the re-parse cost is
// negligible.
async function processExtends(
	result: Awaited<ReturnType<typeof invokeC12>>,
	visited: Set<string>,
): Promise<Config> {
	const loadedConfig: Config = result.config;
	const loadedFile = result.configFile;

	if (loadedFile === undefined || !existsSync(loadedFile)) {
		return loadedConfig;
	}

	const canonicalFile = path.resolve(loadedFile);
	const anchored = anchorWorkspaceRoot(loadedConfig, path.dirname(canonicalFile));
	if (visited.has(canonicalFile)) {
		const cycle = [...visited, canonicalFile].join(" -> ");
		throw new Error(`Circular extends detected: ${cycle}.`);
	}

	const { extends: extendsValue, ...configWithoutExtends } = anchored;
	if (extendsValue === undefined) {
		return anchored;
	}

	visited.add(canonicalFile);
	try {
		const extendList = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
		const configFileDirectory = path.dirname(canonicalFile);
		const layers: Array<Config> = [];

		for (const entry of extendList) {
			const target = path.isAbsolute(entry)
				? entry
				: path.resolve(configFileDirectory, entry);

			let extendedResult;
			try {
				extendedResult = await invokeC12(target, path.dirname(target));
			} catch (err) {
				throw new Error(`Failed to resolve extends "${entry}" from "${canonicalFile}".`, {
					cause: err,
				});
			}

			const extendedConfig = await processExtends(extendedResult, visited);
			layers.push(extendedConfig);
		}

		return merger(configWithoutExtends, ...layers);
	} finally {
		visited.delete(canonicalFile);
	}
}

const EMPTY_ARRAY_DEFAULT_KEYS = new Set([
	"collectCoverageFrom",
	"formatters",
	"luauRoots",
	"reporters",
	"roots",
	"selectProjects",
	"setupFiles",
	"setupFilesAfterEnv",
	"snapshotSerializers",
]);

const EMPTY_OBJECT_DEFAULT_KEYS = new Set(["coverageThreshold", "snapshotFormat"]);

const MERGEABLE_KEYS = new Set([
	...EMPTY_ARRAY_DEFAULT_KEYS,
	...EMPTY_OBJECT_DEFAULT_KEYS,
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"testMatch",
	"testPathIgnorePatterns",
]);

function isMergerFunction(value: unknown): value is (defaults: unknown) => unknown {
	return typeof value === "function";
}

function shouldResolveMergerFunction(
	key: string,
	value: unknown,
): value is (defaults: unknown) => unknown {
	return isMergerFunction(value) && MERGEABLE_KEYS.has(key);
}

function defaultForMergerKey(key: string): unknown {
	const defaultValue = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
	if (Array.isArray(defaultValue)) {
		return [...defaultValue];
	}

	if (EMPTY_ARRAY_DEFAULT_KEYS.has(key)) {
		return [];
	}

	return {};
}

function resolveFunctionValues(config: Config): Config {
	const { test, ...rest } = config;

	const resolvedRest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rest)) {
		resolvedRest[key] = shouldResolveMergerFunction(key, value)
			? value(defaultForMergerKey(key))
			: value;
	}

	if (test === undefined) {
		return resolvedRest;
	}

	const resolvedTest: Record<string, unknown> = {};
	for (const [innerKey, innerValue] of Object.entries(test)) {
		resolvedTest[innerKey] = shouldResolveMergerFunction(innerKey, innerValue)
			? innerValue(defaultForMergerKey(innerKey))
			: innerValue;
	}

	return { ...resolvedRest, test: resolvedTest };
}
