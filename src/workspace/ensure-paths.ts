import { isRojoTreeNode, loadRojoProject, resolveMountPath } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { PackageDescriptor } from "./preflight.ts";

export function ensurePackageDirectories(
	descriptors: Array<PackageDescriptor>,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	for (const descriptor of descriptors) {
		ensurePackageDirectory(fileSystem, descriptor);
	}
}

function isDirectoryPath(node: RojoTreeNode, pathValue: string): boolean {
	if (path.extname(pathValue) === "") {
		return true;
	}

	for (const key of Object.keys(node)) {
		if (!key.startsWith("$")) {
			return true;
		}
	}

	return false;
}

function collectDirectoryPaths(
	fileSystem: FileSystem,
	node: RojoTreeNode,
	projectDirectory: string,
): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string" && isDirectoryPath(node, value)) {
			const absolute = resolveMountPath(projectDirectory, value);
			if (!fileSystem.existsSync(absolute)) {
				fileSystem.mkdirSync(absolute, { recursive: true });
			}

			continue;
		}

		if (isRojoTreeNode(value) && !key.startsWith("$")) {
			collectDirectoryPaths(fileSystem, value, projectDirectory);
		}
	}
}

function ensurePackageDirectory(fileSystem: FileSystem, descriptor: PackageDescriptor): void {
	if (!fileSystem.existsSync(descriptor.rojoProjectPath)) {
		return;
	}

	let project;
	try {
		project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	} catch {
		return;
	}

	const projectDirectory = path.dirname(descriptor.rojoProjectPath);
	collectDirectoryPaths(fileSystem, project.tree, projectDirectory);
}
