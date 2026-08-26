import { loadConfig as c12LoadConfig, type LoadConfigOptions } from "c12";
import { defuFn } from "defu";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG, validateConfig } from "./schema.ts";

/**
 * A config module as `require` hands it back. An ESM config arrives with the
 * config under `default`; c12's `resolveModule` unwraps it, and
 * `validateConfig` parses the result.
 */
interface ConfigModule {
	readonly default?: unknown;
}

interface ExtendsLayerRequest {
	/**
	 * Absolute path of the config declaring `extends`; entries resolve against
	 * its directory.
	 */
	canonicalFile: string;
	extendList: Array<string>;
	visited: Set<string>;
}

type MergerKey =
	| "collectCoverageFrom"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "coverageThreshold"
	| "formatters"
	| "luauRoots"
	| "reporters"
	| "roots"
	| "selectProjects"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "snapshotFormat"
	| "snapshotSerializers"
	| "testMatch"
	| "testPathIgnorePatterns";

type MergerDefault = NonNullable<ResolvedConfig[MergerKey]>;

export function resolveConfig(config: Config): ResolvedConfig {
	validateConfig(config);

	const { gameOutput, outputFile, test, ...rest } = config;

	// Flatten test: block onto resolved config so downstream consumers
	// (executor, projects, test-script, formatters) see jest options at the
	// top level. TODO: refactor consumers to read `config.test.*` directly.
	const resolved: ResolvedConfig = { ...DEFAULT_CONFIG, ...test, ...rest };

	// `gameOutput: true` / `outputFile: true` are shorthand for the
	// conventional `game-output.log` / `jest-output.log` under the root.
	// Expand here so downstream consumers only ever see a path string.
	if (gameOutput !== undefined) {
		resolved.gameOutput =
			gameOutput === true ? path.join(resolved.rootDir, "game-output.log") : gameOutput;
	}

	if (outputFile !== undefined) {
		resolved.outputFile =
			outputFile === true ? path.join(resolved.rootDir, "jest-output.log") : outputFile;
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
async function seaImport(id: string): Promise<ConfigModule | JSONValue> {
	if (id.endsWith(".json")) {
		const content = await readFile(id, "utf-8");
		return JSON.parse(content);
	}

	const requireConfig: (moduleId: string) => ConfigModule = createRequire(id);
	return requireConfig(id);
}

// defuFn wants a non-empty argument list, which a variadic array can't prove.
// The leading `{}` supplies it and contributes nothing: defu gives the first
// source the highest priority, so an empty one leaves the merge order intact.
function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn({}, ...sources);
}

async function invokeC12(configFile: string | undefined, cwd: string) {
	let options: LoadConfigOptions<Config> = {
		name: "jest",
		configFileRequired: configFile !== undefined,
		cwd,
		dotenv: false,
		extend: false,
		globalRc: false,
		merger,
		omit$Keys: true,
		packageJson: false,
		rcFile: false,
	};
	if (configFile !== undefined) {
		options = { ...options, configFile };
	}

	// In SEA mode, jiti's babel.cjs can't be resolved from the
	// single-executable archive. Bypass jiti entirely by providing a
	// custom import function.
	return isSea()
		? c12LoadConfig<Config>({ ...options, import: seaImport })
		: c12LoadConfig<Config>(options);
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
	const loadedConfig = result.config;
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
		const layers = await loadExtendsLayers({ canonicalFile, extendList, visited });
		return merger(configWithoutExtends, ...layers);
	} finally {
		visited.delete(canonicalFile);
	}
}

/**
 * Load each `extends` entry in declaration order, recursing so a base config
 * may itself extend. Returned layers are lowest-priority-last, matching the
 * order `merger` expects.
 */
async function loadExtendsLayers({
	canonicalFile,
	extendList,
	visited,
}: ExtendsLayerRequest): Promise<Array<Config>> {
	const configFileDirectory = path.dirname(canonicalFile);
	const layers: Array<Config> = [];

	for (const entry of extendList) {
		const target = path.isAbsolute(entry) ? entry : path.resolve(configFileDirectory, entry);

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

	return layers;
}

const EMPTY_ARRAY_DEFAULT_KEYS: ReadonlySet<MergerKey> = new Set<MergerKey>([
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

const EMPTY_OBJECT_DEFAULT_KEYS: ReadonlySet<MergerKey> = new Set<MergerKey>([
	"coverageThreshold",
	"snapshotFormat",
]);

const MERGEABLE_KEYS: ReadonlySet<string> = new Set<MergerKey>([
	...EMPTY_ARRAY_DEFAULT_KEYS,
	...EMPTY_OBJECT_DEFAULT_KEYS,
	"coveragePathIgnorePatterns",
	"coverageReporters",
	"testMatch",
	"testPathIgnorePatterns",
]);

function isMergerFunction(value: unknown): value is (defaults: MergerDefault) => MergerDefault {
	return typeof value === "function";
}

function isMergerKey(key: string): key is MergerKey {
	return MERGEABLE_KEYS.has(key);
}

function defaultForMergerKey(key: MergerKey): MergerDefault {
	const defaultValue = DEFAULT_CONFIG[key];
	if (Array.isArray(defaultValue)) {
		return [...defaultValue];
	}

	if (EMPTY_ARRAY_DEFAULT_KEYS.has(key)) {
		return [];
	}

	return {};
}

function resolveFunctionValues({ test, ...rest }: Config) {
	const resolvedRest = Object.fromEntries(
		Object.entries(rest).map(([key, value]) => [
			key,
			isMergerKey(key) && isMergerFunction(value) ? value(defaultForMergerKey(key)) : value,
		]),
	);

	if (test === undefined) {
		return resolvedRest;
	}

	const resolvedTest = Object.fromEntries(
		Object.entries(test).map(([innerKey, innerValue]) => [
			innerKey,
			isMergerKey(innerKey) && isMergerFunction(innerValue)
				? innerValue(defaultForMergerKey(innerKey))
				: innerValue,
		]),
	);

	return { ...resolvedRest, test: resolvedTest };
}
