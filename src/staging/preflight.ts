import * as path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { ensurePackageDirectories } from "./ensure-paths.ts";
import { type PackageDescriptor, validatePackages } from "./validation.ts";

/**
 * Create mounted directories before validating the paths Rojo needs to build.
 * @param descriptors - Projects to prepare and validate.
 * @param fileSystem - File system to prepare.
 * @returns Whether every project is ready to build.
 */
export function runPreflight(
	descriptors: Array<PackageDescriptor>,
	fileSystem: FileSystem,
): boolean {
	ensurePackageDirectories(descriptors, fileSystem);
	const errors = validatePackages(descriptors, fileSystem);
	if (errors.length === 0) {
		return true;
	}

	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}

	return false;
}

/**
 * Validate a single package using its resolved project path.
 * @param config - Package configuration.
 * @param fileSystem - File system to prepare.
 * @returns Whether the project is ready to build.
 */
export function runProjectPreflight(config: ResolvedConfig, fileSystem: FileSystem): boolean {
	return runPreflight(
		[
			{
				name: path.basename(config.rootDir),
				packageDirectory: config.rootDir,
				rojoProjectPath:
					config.rojoProject ?? path.join(config.rootDir, "default.project.json"),
			},
		],
		fileSystem,
	);
}
