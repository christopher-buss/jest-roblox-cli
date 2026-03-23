import { RojoResolver } from "@roblox-ts/rojo-resolver";

import { createRequire } from "node:module";
import * as path from "node:path";

export interface SetupResolverOptions {
	configDirectory: string;
	resolveModule?: (specifier: string) => string;
	rojoConfigPath: string;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".lua", ".luau"];

export function createSetupResolver(options: SetupResolverOptions): (input: string) => string {
	const { configDirectory, resolveModule, rojoConfigPath } = options;
	const resolve = resolveModule ?? createRequire(path.join(configDirectory, "noop.js")).resolve;
	const rojoResolver = RojoResolver.fromPath(rojoConfigPath);

	return (input: string): string => {
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
