import {
	collectRequiredPaths,
	type LoadedRojoProject,
	loadRojoProject,
	resolveMountPath,
} from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

/** One package that failed the preflight check. */
export interface PreflightError {
	/** Package name. */
	package: string;
	/** What is missing or broken. */
	reason: string;
}

/** A package as the synthesizer mounts it. */
export interface PackageDescriptor {
	/** Package name. */
	name: string;
	/** Absolute package directory. */
	packageDirectory: string;
	/** Absolute path of the package's Rojo project file. */
	rojoProjectPath: string;
}

/**
 * Check that each package's Rojo project and its `$path` targets exist.
 * @param descriptors - Packages to check.
 * @param fileSystem - File system to probe.
 * @returns One error per problem found; empty when all pass.
 */
export function validatePackages(
	descriptors: Array<PackageDescriptor>,
	fileSystem: FileSystem = nodeFileSystem,
): Array<PreflightError> {
	const errors: Array<PreflightError> = [];
	for (const descriptor of descriptors) {
		validatePackage({ descriptor, errors, fileSystem });
	}

	return errors;
}

function validatePackage({
	descriptor,
	errors,
	fileSystem,
}: {
	readonly descriptor: PackageDescriptor;
	readonly errors: Array<PreflightError>;
	readonly fileSystem: FileSystem;
}): void {
	if (!fileSystem.existsSync(descriptor.rojoProjectPath)) {
		errors.push({
			package: descriptor.name,
			reason: `rojoProject not found at ${path.relative(descriptor.packageDirectory, descriptor.rojoProjectPath)}`,
		});
		return;
	}

	let project: LoadedRojoProject;
	try {
		project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	} catch (err) {
		errors.push({
			package: descriptor.name,
			reason: `failed to parse rojoProject: ${String(err)}`,
		});
		return;
	}

	const paths: Array<string> = [];
	collectRequiredPaths(project.tree, paths);

	const projectDirectory = path.dirname(descriptor.rojoProjectPath);
	for (const relative of paths) {
		if (!fileSystem.existsSync(resolveMountPath(projectDirectory, relative))) {
			errors.push({
				package: descriptor.name,
				reason: `$path target not found: ${relative}`,
			});
		}
	}
}
