import { loadConfig as c12LoadConfig, SUPPORTED_EXTENSIONS } from "c12";
import * as path from "node:path";
import process from "node:process";

import { nodeTsconfigReader, type TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { type ChildProcessRunner, nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ConfigLayer, ConfigLoadContext } from "./config-layers.ts";
import { invokeC12, isLuauConfigPath, loadLuauLayer, processExtends } from "./config-layers.ts";
import type { Config } from "./config-types.ts";
import { validateConfig } from "./config-validation.ts";
import { resolveFunctionValues } from "./merger-functions.ts";
import type { ResolvedConfig } from "./resolved-config.ts";
import { DEFAULT_CONFIG } from "./resolved-config.ts";

const LUAU_CONFIG_FILENAME = "jest.config.luau";

/** The c12 load function; it bypasses any injected `FileSystem`. */
export type ConfigLoader = typeof c12LoadConfig;

export const nodeConfigLoader: ConfigLoader = c12LoadConfig;

/** The collaborators a config load reaches c12 and the disk through. */
export interface ConfigLoadOptions {
	/** How a Luau Config that holds code runs lute. */
	childProcess?: ChildProcessRunner;
	/** How the c12 layers are loaded. */
	configLoader?: ConfigLoader;
	/** Where a resolved config file is looked for. */
	fileSystem?: FileSystem;
	/** Reads compiled output roots when a luauRoots merger extends defaults. */
	tsconfigReader?: TsconfigReader;
}

/** Where a config load starts, plus the collaborators it reaches. */
export interface ConfigLoadRequest extends ConfigLoadOptions {
	/** Explicit config file, relative to `cwd`. */
	readonly configPath?: string | undefined;
	/** Directory to search and resolve from. Defaults to `process.cwd()`. */
	readonly cwd?: string | undefined;
}

/** One package config, as declared and as resolved. */
export interface PackageConfig {
	/** The validated config without `DEFAULT_CONFIG` applied. */
	declared: Config;
	/** The same layers resolved, as {@link loadConfig} returns them. */
	resolved: ResolvedConfig;
}

/** Loads one workspace package's config. */
export type PackageConfigLoader = typeof loadPackageConfigAsync;

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

	const { coverage: isCoverageAlias, ...jestOptions } = test ?? {};
	const resolved: ResolvedConfig = { ...DEFAULT_CONFIG, ...jestOptions, ...rest };
	resolved.collectCoverage =
		jestOptions.collectCoverage ?? isCoverageAlias ?? resolved.collectCoverage;

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
 * Load a package config once and return it both as declared and as resolved.
 *
 * @param options - Start point and load collaborators.
 * @returns The declared and the resolved config.
 * @rejects If the config is missing, invalid, ambiguous or fails to load.
 */
export async function loadPackageConfigAsync({
	childProcess = nodeChildProcessRunner,
	configLoader = nodeConfigLoader,
	configPath,
	cwd = process.cwd(),
	fileSystem = nodeFileSystem,
	tsconfigReader = nodeTsconfigReader,
}: ConfigLoadRequest): Promise<PackageConfig> {
	const { config, loadDirectory } = await loadConfigLayers({
		configPath,
		context: { childProcess, configLoader, fileSystem },
		cwd,
		tsconfigReader,
	});
	const declared = { ...config };
	config.rootDir = anchorRootDirectory({ cwd, loadDirectory, rootDirectory: config.rootDir });

	return { declared, resolved: resolveConfig(config) };
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
	childProcess = nodeChildProcessRunner,
	configLoader = nodeConfigLoader,
	configPath,
	cwd = process.cwd(),
	fileSystem = nodeFileSystem,
	tsconfigReader = nodeTsconfigReader,
}: ConfigLoadRequest = {}): Promise<ResolvedConfig> {
	const { config, loadDirectory } = await loadConfigLayers({
		configPath,
		context: { childProcess, configLoader, fileSystem },
		cwd,
		tsconfigReader,
	});
	config.rootDir = anchorRootDirectory({ cwd, loadDirectory, rootDirectory: config.rootDir });

	return resolveConfig(config);
}

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
		return path.resolve(cwd);
	}

	// Unchanged spelling: `resolveUniverseAnchor` and
	// `filter-projects-by-files` compare prefixes against it.
	if (isAbsolutePath(normalizeWindowsPath(rootDirectory))) {
		return rootDirectory;
	}

	return path.resolve(loadDirectory, rootDirectory);
}

function isC12NotFoundError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("cannot be resolved");
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
		return loadLuauLayer({ configFile, context, requested: configPath });
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

		return loadLuauLayer({ configFile: luauFile, context, requested: luauFile });
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

async function loadConfigLayers({
	configPath,
	context,
	cwd,
	tsconfigReader,
}: {
	readonly configPath: string | undefined;
	readonly context: ConfigLoadContext;
	readonly cwd: string;
	readonly tsconfigReader: TsconfigReader;
}): Promise<LoadedConfig> {
	const { fileSystem } = context;
	const result = await loadEntryLayer({ configPath, context, cwd });
	const mergedConfig = await processExtends({ context, result, visited: new Set() });
	const loadedFile = result.configFile;

	const loadDirectory =
		loadedFile !== undefined && fileSystem.existsSync(loadedFile)
			? path.dirname(path.resolve(loadedFile))
			: cwd;
	return {
		config: validateConfig(
			resolveFunctionValues(mergedConfig, {
				fileSystem,
				rootDirectory: anchorRootDirectory({
					cwd,
					loadDirectory,
					rootDirectory: mergedConfig.rootDir,
				}),
				tsconfigReader,
			}),
		),
		loadDirectory,
	};
}
