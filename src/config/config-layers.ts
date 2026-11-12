import type { LoadConfigOptions, ResolvedConfig } from "c12";
import { defuFn } from "defu";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { isSeaBuild } from "../utils/sea.ts";
import type { Config } from "./config-types.ts";
import { validateConfigLayer } from "./config-validation.ts";
import type { ConfigLoader, ConfigLoadOptions } from "./loader.ts";
import { loadLuauConfig } from "./luau-config-loader.ts";

/** Load options with every field supplied. */
export type ConfigLoadContext = Required<
	Pick<ConfigLoadOptions, "childProcess" | "configLoader" | "fileSystem">
>;

/** `configFile` may name a missing file when a c12 search matched nothing. */
export interface ConfigLayer {
	/** Config the layer declares. */
	config: Config;
	/** Path c12 resolved for the layer. */
	configFile?: string | undefined;
}

interface ConfigModule {
	readonly default?: unknown;
}

interface ExtendsLayerRequest {
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

	// SEA: jiti's babel.cjs can't resolve from the single-executable archive.
	return isSeaBuild()
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
 * Resolve a layer's `extends` chain and merge it under the layer. Done here,
 * not by c12: c12 issue #57 doubles the dirname of relative `extends` paths.
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

/**
 * A SEA binary's `import()` fails on disk paths (ERR_UNKNOWN_BUILTIN_MODULE);
 * `require()` works.
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

function merger(...sources: Array<Config | null | undefined>): Config {
	return defuFn({}, ...sources);
}

/**
 * Must run per layer before merge; after it the declaring directory is lost.
 *
 * @param config - Layer config.
 * @param baseDirectory - Directory of the file that declares the layer.
 * @returns The config with an absolute `workspace.root`.
 */
function anchorWorkspaceRoot(config: Config, baseDirectory: string): Config {
	const { workspace } = config;
	if (workspace?.root === undefined || isAbsolutePath(normalizeWindowsPath(workspace.root))) {
		return config;
	}

	return {
		...config,
		workspace: { ...workspace, root: path.resolve(baseDirectory, workspace.root) },
	};
}

function anchorLayerRootDirectory(config: Config, configFile: string | undefined): Config {
	const { rootDir } = config;
	if (
		configFile === undefined ||
		rootDir === undefined ||
		isAbsolutePath(normalizeWindowsPath(rootDir))
	) {
		return config;
	}

	return { ...config, rootDir: path.resolve(path.dirname(configFile), rootDir) };
}

/**
 * Returns layers lowest-priority-last, the order `merger` expects.
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

		const { config, configFile } = extendedResult;
		const result = { ...extendedResult, config: anchorLayerRootDirectory(config, configFile) };
		layers.push(await processExtends({ context, result, visited }));
	}

	return layers;
}
