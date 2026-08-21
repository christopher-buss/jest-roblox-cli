import { RojoResolver } from "@isentinel/rojo-utils";

import { createRequire } from "node:module";
import * as path from "node:path";

/**
 * Resolvers already built, keyed by the rojo project file they were built
 * from. Packages that share a rojo project then share its tree walk.
 */
export type RojoResolverCache = Map<string, RojoResolver>;

export interface SetupResolverOptions {
	/**
	 * Reuse resolvers across calls. Caller-owned: `RojoResolver.fromPath`
	 * snapshots the project tree, so how long that snapshot stays true is the
	 * caller's question. Omit it and every call builds its own.
	 */
	cache?: RojoResolverCache | undefined;
	configDirectory: string;
	resolveModule?: (specifier: string) => string;
	rojoConfigPath: string;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".lua", ".luau"];

export function createRojoResolverCache(): RojoResolverCache {
	return new Map<string, RojoResolver>();
}

export function createSetupResolver({
	cache,
	configDirectory,
	resolveModule,
	rojoConfigPath,
}: SetupResolverOptions): (input: string) => string {
	const resolve = resolveModule ?? createRequire(path.join(configDirectory, "noop.js")).resolve;
	const rojoResolver = resolveRojo(rojoConfigPath, cache);

	return (input): string => {
		let absolutePath: string;

		if (isRelativePath(input)) {
			absolutePath = path.resolve(configDirectory, input);
		} else {
			// Validate the package is installed (probes extensions)
			resolvePackageSpecifier(resolve, input);

			// Use the logical node_modules path — require.resolve follows
			// symlinks to real paths outside the project, which RojoResolver
			// won't recognize
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

// mapFsPathToDataModel is not an equivalent substitution for this walk: the
// resolver follows the pnpm symlink and any nested rojo config, so it strips
// `out` from a package path where the tree mapper keeps it. That walk dominates
// the cost of resolving a package's setup files, so a shared cache spares every
// package after the first that mounts the same project file.
function resolveRojo(rojoConfigPath: string, cache: RojoResolverCache | undefined): RojoResolver {
	const cached = cache?.get(rojoConfigPath);
	if (cached !== undefined) {
		return cached;
	}

	const resolver = RojoResolver.fromPath(rojoConfigPath);
	cache?.set(rojoConfigPath, resolver);
	return resolver;
}

function isRelativePath(input: string): boolean {
	return input.startsWith("./") || input.startsWith("../");
}

function resolvePackageSpecifier(resolve: (specifier: string) => string, input: string): void {
	// Try direct resolution first
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
