import { RojoResolver } from "@isentinel/rojo-utils";

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { ResolvedConfig } from "./resolved-config.ts";

/** Resolvers keyed by the rojo project file they were built from. */
type RojoResolverCache = Map<string, RojoResolver>;

/** Inputs for `createSetupResolver`. */
interface SetupResolverOptions {
	/** Resolvers reused across calls; omit to build one per call. */
	cache?: RojoResolverCache | undefined;
	/** Directory relative setup paths and package specifiers resolve from. */
	configDirectory: string;
	/** Builds the resolver for a rojo project file. */
	createResolver?: typeof RojoResolver.fromPath;
	/** Checks a package specifier is installed. */
	resolveModule?: (specifier: string) => string;
	/** Rojo project file that maps setup paths to Instances. */
	rojoConfigPath: string;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".lua", ".luau"];

/** Signature of {@link createSetupResolver}, for injection. */
export type SetupResolverFactory = typeof createSetupResolver;

/** Where one config's setup files resolve from. */
export interface SetupFileSource {
	/** Directory relative setup paths and package specifiers resolve from. */
	configDirectory: string;
	/** Rojo project file that maps setup paths to Instances. */
	rojoConfigPath: string;
}

/**
 * Build a resolver that maps a setup file path or package specifier to its
 * Roblox Instance path.
 *
 * @param options - Config directory, Rojo project and optional seams.
 * @returns A function that gives the `/`-joined Instance path of an input. It
 *   throws when the Rojo tree has no path for the input.
 */
export function createSetupResolver({
	cache,
	configDirectory,
	createResolver = RojoResolver.fromPath.bind(RojoResolver),
	resolveModule,
	rojoConfigPath,
}: SetupResolverOptions): (input: string) => string {
	const resolve =
		resolveModule ?? createRequire(pathToFileURL(configDirectory + path.sep)).resolve;
	const rojoResolver = resolveRojo({ cache, createResolver, rojoConfigPath });

	return (input): string => {
		let absolutePath: string;

		if (isRelativePath(input)) {
			absolutePath = path.resolve(configDirectory, input);
		} else {
			resolvePackageSpecifier(resolve, input);

			// Not the require.resolve path: it follows symlinks out of the
			// tree RojoResolver knows.
			absolutePath = path.resolve(configDirectory, "node_modules", input);
		}

		const rbxPath = rojoResolver.getRbxPathFromFilePath(absolutePath);

		if (rbxPath === undefined) {
			throw new Error(
				`No matching path found in rojo project tree for "${input}" (resolved to: ${absolutePath})`,
			);
		}

		return rbxPath.join("/");
	};
}

/**
 * Rewrite every config's setup file paths in place to Instance paths, one
 * resolver per source.
 * @param options - Configs, Rojo resolver factory and each config's source.
 */
export function resolveAllSetupFilePaths({
	configs,
	createSetupResolver: createResolver,
	sourceOf,
}: {
	/** Configs whose setup file paths resolve in place. */
	configs: ReadonlyArray<ResolvedConfig>;
	/** Builds the resolver of one source. */
	createSetupResolver: SetupResolverFactory;
	/** Where a config's setup files resolve from. */
	sourceOf: (config: ResolvedConfig) => SetupFileSource;
}): void {
	const resolvers = new Map<string, (input: string) => string>();
	const cache = createRojoResolverCache();

	for (const config of configs) {
		if (config.setupFiles === undefined && config.setupFilesAfterEnv === undefined) {
			continue;
		}

		const source = sourceOf(config);
		const key = JSON.stringify([source.configDirectory, source.rojoConfigPath]);
		let resolve = resolvers.get(key);
		if (resolve === undefined) {
			resolve = createResolver({ cache, ...source });
			resolvers.set(key, resolve);
		}

		applySetupResolver(config, resolve);
	}
}

/**
 * Do not swap in mapFsPathToDataModel: it keeps `out` on pnpm package paths.
 *
 * @param options - Cache, resolver factory and Rojo project file.
 * @returns The cached or newly built resolver.
 */
function resolveRojo({
	cache,
	createResolver,
	rojoConfigPath,
}: {
	readonly cache: RojoResolverCache | undefined;
	readonly createResolver: typeof RojoResolver.fromPath;
	readonly rojoConfigPath: string;
}): RojoResolver {
	const cached = cache?.get(rojoConfigPath);
	if (cached !== undefined) {
		return cached;
	}

	const resolver = createResolver(rojoConfigPath);
	cache?.set(rojoConfigPath, resolver);
	return resolver;
}

function isRelativePath(input: string): boolean {
	return input.startsWith("./") || input.startsWith("../");
}

function resolvePackageSpecifier(resolve: (specifier: string) => string, input: string): void {
	try {
		resolve(input);
		return;
	} catch {
		// Try with known extensions
	}

	for (const extension of PROBE_EXTENSIONS) {
		try {
			resolve(`${input}${extension}`);
			return;
		} catch {
			// continue probing
		}
	}

	throw new Error(`Could not resolve module "${input}". Ensure the package is installed.`);
}

/**
 * Create an empty resolver cache.
 *
 * @returns A new cache.
 */
function createRojoResolverCache(): RojoResolverCache {
	return new Map<string, RojoResolver>();
}

function applySetupResolver(
	config: Pick<ResolvedConfig, "setupFiles" | "setupFilesAfterEnv">,
	resolve: (input: string) => string,
): void {
	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}
