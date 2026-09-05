import {
	collectPaths,
	type LoadedRojoProject,
	loadRojoProject,
	resolveMountPath,
} from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

export interface PreflightError {
	package: string;
	reason: string;
}

export interface PackageDescriptor {
	name: string;
	packageDirectory: string;
	rojoProjectPath: string;
}

export function validatePackages(
	descriptors: Array<PackageDescriptor>,
	fileSystem: FileSystem = nodeFileSystem,
): Array<PreflightError> {
	const errors: Array<PreflightError> = [];
	for (const descriptor of descriptors) {
		validatePackage(fileSystem, descriptor, errors);
	}

	return errors;
}

function validatePackage(
	fileSystem: FileSystem,
	descriptor: PackageDescriptor,
	errors: Array<PreflightError>,
): void {
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
	collectPaths(project.tree, paths);

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
