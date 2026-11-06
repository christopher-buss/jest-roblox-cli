import type { LoadConfigOptions, ResolvedConfig } from "c12";
import { defuFn } from "defu";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import { validateConfigLayer } from "./config-validation.ts";
import type { ConfigLoader, ConfigLoadOptions } from "./loader.ts";
import { loadLuauConfig } from "./luau-config-loader.ts";
import type { Config } from "./schema.ts";

/** Load options with every field supplied. */
export type ConfigLoadContext = Required<ConfigLoadOptions>;

/** `configFile` may name a missing file when a c12 search matched nothing. */
export interface ConfigLayer {
	/** Config the layer declares. */
	config: Config;
	/** Path c12 resolved for the layer. */
	configFile?: string | undefined;
}

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
	context: ConfigLoadContext;
	extendList: Array<string>;
	visited: Set<string>;
}

/**
 * Load one config file through c12 with its own `extends` handling off.
 *
 * @param options - Config file, loader, search directory and file system.
 * @returns The c12 load result.
 * @rejects If c12 fails to load the config.
 */
export async function invokeC12({
	configFile,
	configLoader,
	cwd,
	fileSystem,
}: {
	/** Explicit config path; `undefined` makes c12 search `cwd`. */
	readonly configFile: string | undefined;
	/** C12 load function. */
	readonly configLoader: ConfigLoader;
	/** Directory c12 searches and resolves from. */
	readonly cwd: string;
	/** File system for JSON reads in SEA mode. */
	readonly fileSystem: FileSystem;
}): Promise<ResolvedConfig<Config>> {
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
		? configLoader<Config>({ ...options, import: async (id) => seaImport(id, fileSystem) })
		: configLoader<Config>(options);
}

/**
 * Check whether a config path names a Luau Config.
 *
 * @param filePath - Config path to test.
 * @returns Whether the path names a Luau Config.
 */
export function isLuauConfigPath(filePath: string): boolean {
	return filePath.endsWith(".luau");
}

/**
 * Load one Luau Config as a layer.
 *
 * @param options - Config file, load context and the path as written.
 * @returns The validated layer.
 * @rejects If the file is missing, fails to evaluate or fails validation.
 */
export async function loadLuauLayer({
	configFile,
	context,
	requested,
}: {
	/** Absolute path of the Luau Config. */
	readonly configFile: string;
	/** Load context; its child process runs lute. */
	readonly context: ConfigLoadContext;
	/** Path as the user wrote it, for the not-found error. */
	readonly requested: string;
}): Promise<ConfigLayer> {
	const { childProcess, fileSystem } = context;
	if (!fileSystem.existsSync(configFile)) {
		throw new Error(`Config file not found: ${requested}`);
	}

	const config = validateConfigLayer(
		await loadLuauConfig(configFile, { childProcess, fileSystem }),
	);
	return { config, configFile };
}

/**
 * Resolve a layer's `extends` chain and merge it under the layer.
 *
 * `c12` mis-resolves relative `extends` paths whose `dirname()` is non-empty
 * (e.g. "../../jest.shared.ts"): it adds dirname(source) to its internal cwd
 * but leaves source unchanged, then re-applies dirname when resolving the file
 * — duplicating the path component. See c12 issue #57. We disable c12's extend
 * handling and resolve the chain ourselves against the loaded config file's
 * actual directory.
 *
 * `visited` is stack-local — popped on unwind via `finally` — so a diamond
 * graph (child → [a, b], both → base) loads `base` twice rather than failing
 * as a false cycle. Config load is one-time at startup; the re-parse cost is
 * negligible.
 *
 * @param options - Load context, loaded layer and the files on the current
 *   extends stack.
 * @returns The layer merged over its extended configs.
 * @rejects If the chain has a cycle or an entry fails to load.
 */
export async function processExtends({
	context,
	result,
	visited,
}: {
	/** Load context for nested c12 calls. */
	readonly context: ConfigLoadContext;
	/** Layer whose `extends` to resolve. */
	readonly result: ConfigLayer;
	/** Canonical files on the current extends stack. */
	readonly visited: Set<string>;
}): Promise<Config> {
	const { fileSystem } = context;
	const loadedConfig = result.config;
	const loadedFile = result.configFile;

	if (loadedFile === undefined || !fileSystem.existsSync(loadedFile)) {
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
		const layers = await loadExtendsLayers({ canonicalFile, context, extendList, visited });
		return merger(configWithoutExtends, ...layers);
	} finally {
		visited.delete(canonicalFile);
	}
}

function isSea(): boolean {
	return process.env["JEST_ROBLOX_SEA"] === "true";
}

/**
 * A SEA binary's ESM loader can't `import()` a file off disk — Node routes
 * every dynamic import through the single-executable's built-in resolver, so
 * any path fails (`No such built-in module` / `ERR_UNKNOWN_BUILTIN_MODULE`).
 * `require()` is unaffected, and Node's `require` handles everything a config
 * needs: TypeScript type-stripping for `.ts`/`.mts`/`.cts`, ESM `export
 * default` (returned as `{ default }`), and bare-specifier resolution from the
 * project's on-disk `node_modules`. Anchoring the require at the config path
 * lets a config that imports a runtime value (e.g. `defineConfig` from
 * `@isentinel/jest-roblox`) resolve it relative to itself; a genuinely
 * unresolvable import surfaces Node's standard module-resolution error. `.json`
 * keeps its read + parse path (a bare `require` of JSON works too, but reading
 * avoids relying on CJS JSON-module semantics).
 *
 * @param id - Absolute path of the config module.
 * @param fileSystem - File system for JSON reads.
 * @returns The module, or the parsed JSON.
 * @rejects If the JSON file cannot be read or parsed.
 */
async function seaImport(id: string, fileSystem: FileSystem): Promise<ConfigModule | JSONValue> {
	if (id.endsWith(".json")) {
		const content = await fileSystem.promises.readFile(id, "utf-8");
		return JSON.parse(content);
	}

	const requireConfig: (moduleId: string) => ConfigModule = createRequire(id);
	return requireConfig(id);
}

/**
 * `defuFn` wants a non-empty argument list, which a variadic array can't prove.
 * The leading `{}` supplies it and contributes nothing: defu gives the first
 * source the highest priority, so an empty one leaves the merge order intact.
 *
 * @param sources - Configs in priority order, highest first.
 * @returns The merged config.
 */
function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn({}, ...sources);
}

/**
 * `workspace.root` is relative in source; anchor it to the directory of the
 * file that declares it (typically a shared config reached via `extends:`) so
 * the workspace root stays stable regardless of which package directory the CLI
 * runs from. Applied per-layer before merge — once layers merge, the declaring
 * file's directory is no longer recoverable.
 *
 * @param config - Layer config.
 * @param baseDirectory - Directory of the file that declares the layer.
 * @returns The config with an absolute `workspace.root`.
 */
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

/**
 * Load each `extends` entry in declaration order, recursing so a base config
 * may itself extend. Returned layers are lowest-priority-last, matching the
 * order `merger` expects.
 *
 * @param options - Declaring file, load context, entries and extends stack.
 * @returns The resolved layers.
 * @rejects If an entry fails to load or the chain has a cycle.
 */
async function loadExtendsLayers({
	canonicalFile,
	context,
	extendList,
	visited,
}: ExtendsLayerRequest): Promise<Array<Config>> {
	const configFileDirectory = path.dirname(canonicalFile);
	const layers: Array<Config> = [];

	for (const entry of extendList) {
		const target = path.isAbsolute(entry) ? entry : path.resolve(configFileDirectory, entry);

		let extendedResult;
		try {
			extendedResult = isLuauConfigPath(target)
				? await loadLuauLayer({ configFile: target, context, requested: entry })
				: await invokeC12({
						configFile: target,
						configLoader: context.configLoader,
						cwd: path.dirname(target),
						fileSystem: context.fileSystem,
					});
		} catch (err) {
			throw new Error(`Failed to resolve extends "${entry}" from "${canonicalFile}".`, {
				cause: err,
			});
		}

		const extendedConfig = await processExtends({ context, result: extendedResult, visited });
		layers.push(extendedConfig);
	}

	return layers;
}
