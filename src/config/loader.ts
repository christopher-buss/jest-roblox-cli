import { loadConfig as c12LoadConfig, SUPPORTED_EXTENSIONS } from "c12";
import * as path from "node:path";
import process from "node:process";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ConfigLayer, ConfigLoadContext } from "./config-layers.ts";
import { invokeC12, processExtends } from "./config-layers.ts";
import { validateConfig, validateConfigLayer } from "./config-validation.ts";
import { loadLuauConfig } from "./luau-config-loader.ts";
import { resolveFunctionValues } from "./merger-functions.ts";
import type { Config, ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

const LUAU_CONFIG_FILENAME = "jest.config.luau";

/**
 * The c12 load function. It resolves and evaluates a config file through
 * handles of its own, so a `FileSystem` does not reach it.
 */
export type ConfigLoader = typeof c12LoadConfig;

export const nodeConfigLoader: ConfigLoader = c12LoadConfig;

/** The collaborators a config load reaches c12 and the disk through. */
export interface ConfigLoadOptions {
	/** How the c12 layers are loaded. Defaults to the real `loadConfig`. */
	configLoader?: ConfigLoader;
	/**
	 * Where a resolved config file is looked for. Defaults to the real disk.
	 */
	fileSystem?: FileSystem;
}

/** Where a config load starts, plus the collaborators it reaches. */
export interface ConfigLoadRequest extends ConfigLoadOptions {
	/** Explicit config file, relative to `cwd`. */
	readonly configPath?: string | undefined;
	/** Directory to search and resolve from. Defaults to `process.cwd()`. */
	readonly cwd?: string | undefined;
}

/** Loads one package's resolved config. */
export type PackageConfigLoader = typeof loadConfig;

interface LoadedConfig {
	config: Config;
	loadDirectory: string;
}

/**
 * Validate a config, flatten its `test` block and fill in defaults.
 *
 * @param config - Merged user config.
 * @returns The resolved config.
 * @throws If the config fails validation.
 */
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
 * Load, merge and resolve the config found from `cwd` or named by
 * `configPath`.
 *
 * @param options - Start point and load collaborators.
 * @returns The resolved config.
 * @rejects If the config is missing, invalid, ambiguous or fails to load.
 */
export async function loadConfig({
	configLoader = nodeConfigLoader,
	configPath,
	cwd = process.cwd(),
	fileSystem = nodeFileSystem,
}: ConfigLoadRequest = {}): Promise<ResolvedConfig> {
	const { config, loadDirectory } = await loadConfigLayers({
		configPath,
		context: { configLoader, fileSystem },
		cwd,
	});
	config.rootDir = anchorRootDirectory({ cwd, loadDirectory, rootDirectory: config.rootDir });

	return resolveConfig(config);
}

/**
 * Load the user-declared config without merging `DEFAULT_CONFIG`. Returned
 * fields are exactly what the user wrote — omitted fields stay `undefined`.
 * Use this when downstream code must distinguish "user declared X=false" from
 * "X defaulted to false", as workspace consensus checks do.
 *
 * The config is validated (same schema check as `loadConfig`) so workspace
 * mode rejects malformed per-package configs with the same error messaging,
 * rather than comparing unchecked shapes and failing later.
 *
 * @param options - Start point and load collaborators.
 * @returns The merged, validated user config.
 * @rejects If the config is missing, invalid, ambiguous or fails to load.
 */
export async function loadRawConfig({
	configLoader = nodeConfigLoader,
	configPath,
	cwd = process.cwd(),
	fileSystem = nodeFileSystem,
}: ConfigLoadRequest): Promise<Config> {
	const { config } = await loadConfigLayers({
		configPath,
		context: { configLoader, fileSystem },
		cwd,
	});

	return config;
}

/**
 * The c12 error for an unresolvable required config file has this message
 * shape. Other failures (parse errors, import-time exceptions) surface
 * unchanged.
 *
 * @param err - Value c12 rejected with.
 * @returns Whether `err` is the c12 not-found error.
 */
function isC12NotFoundError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("cannot be resolved");
}

function isLuauConfigPath(filePath: string): boolean {
	return filePath.endsWith(".luau");
}

function loadLuauLayer({
	configFile,
	fileSystem,
	requested,
}: {
	readonly configFile: string;
	readonly fileSystem: FileSystem;
	readonly requested: string;
}): ConfigLayer {
	if (!fileSystem.existsSync(configFile)) {
		throw new Error(`Config file not found: ${requested}`);
	}

	return { config: validateConfigLayer(loadLuauConfig(configFile, fileSystem)), configFile };
}

async function loadEntryLayer({
	configPath,
	context,
	cwd,
}: {
	readonly configPath: string | undefined;
	readonly context: ConfigLoadContext;
	readonly cwd: string;
}): Promise<ConfigLayer> {
	const { fileSystem } = context;
	if (configPath !== undefined && isLuauConfigPath(configPath)) {
		const configFile = path.resolve(cwd, configPath);
		return loadLuauLayer({ configFile, fileSystem, requested: configPath });
	}

	const luauFile = path.resolve(cwd, LUAU_CONFIG_FILENAME);
	if (configPath === undefined && fileSystem.existsSync(luauFile)) {
		const scriptFile = SUPPORTED_EXTENSIONS.flatMap((extension) => [
			path.resolve(cwd, `jest.config${extension}`),
			path.resolve(cwd, ".config", `jest${extension}`),
			path.resolve(cwd, ".config", `jest.config${extension}`),
		]).find((candidate) => fileSystem.existsSync(candidate));
		if (scriptFile !== undefined) {
			throw new Error(`Found two jest configs: ${scriptFile} and ${luauFile}. Keep one.`);
		}

		return loadLuauLayer({ configFile: luauFile, fileSystem, requested: luauFile });
	}

	return invokeC12({
		configFile: configPath,
		configLoader: context.configLoader,
		cwd,
		fileSystem,
	}).catch((err: unknown) => {
		if (configPath !== undefined && isC12NotFoundError(err)) {
			throw new Error(`Config file not found: ${configPath}`, { cause: err });
		}

		throw err;
	});
}

/**
 * Keep the entry directory before processExtends merges away each layer's
 * origin.
 *
 * @param options - Config path, load context and start directory.
 * @returns The validated config and the directory of its entry file.
 * @rejects If the config is missing, invalid, ambiguous or fails to load.
 */
async function loadConfigLayers({
	configPath,
	context,
	cwd,
}: {
	readonly configPath: string | undefined;
	readonly context: ConfigLoadContext;
	readonly cwd: string;
}): Promise<LoadedConfig> {
	const { fileSystem } = context;
	const result = await loadEntryLayer({ configPath, context, cwd });
	const mergedConfig = await processExtends({ context, result, visited: new Set() });
	const loadedFile = result.configFile;

	return {
		config: validateConfig(resolveFunctionValues(mergedConfig)),
		// c12 reports a `configFile` even for a search that matched nothing, so
		// the existence check is what distinguishes a real load from a miss.
		loadDirectory:
			loadedFile !== undefined && fileSystem.existsSync(loadedFile)
				? path.dirname(path.resolve(loadedFile))
				: cwd,
	};
}

/**
 * The `rootDir` every consumer anchors on, absolute. A declared relative one
 * anchors on `loadDirectory` — the directory holding the config that declared
 * it, which in workspace mode is the package directory. That is what makes
 * `rootDir: "."` name the package rather than the invocation directory,
 * whether the package config was found by search or named outright with
 * `--config`.
 *
 * An absent `rootDir` still defaults to the invocation directory: a package
 * that declares nothing is opting into the caller's frame of reference, and
 * `--config packages/foo/jest.config.ts` from the workspace root has always
 * meant "run foo's suite from here".
 *
 * Absoluteness is the cross-host question, not `path.resolve`'s: that reads
 * `D:/repo` as a relative filename off Linux and would hang the whole config
 * under `<cwd>/D:/repo`. An already-absolute `rootDir` is passed through in
 * the spelling the config wrote, which is what the prefix-comparing consumers
 * (`resolveUniverseAnchor`, `filter-projects-by-files`) expect to see.
 *
 * @param options - Invocation directory, config directory and declared
 *   `rootDir`.
 * @returns The absolute `rootDir`.
 */
function anchorRootDirectory({
	cwd,
	loadDirectory,
	rootDirectory,
}: {
	readonly cwd: string;
	readonly loadDirectory: string;
	readonly rootDirectory: string | undefined;
}): string {
	if (rootDirectory === undefined) {
		// `cwd` is a caller's string too — `--workspace-root=.` reaches here
		// verbatim — so this branch resolves rather than passing it on. It needs
		// no cross-host guard: a `cwd` names a directory on the host doing the
		// running, while a `rootDir` is committed and read from both.
		return path.resolve(cwd);
	}

	if (isAbsolutePath(normalizeWindowsPath(rootDirectory))) {
		return rootDirectory;
	}

	return path.resolve(loadDirectory, rootDirectory);
}
