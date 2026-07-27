import { loadRojoProject } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { isRojoTreeNode } from "../utils/rojo-tree-node.ts";
import type { PackageDescriptor } from "./preflight.ts";

export function ensurePackageDirectories(descriptors: Array<PackageDescriptor>): void {
	for (const descriptor of descriptors) {
		ensurePackageDirectory(descriptor);
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

function collectDirectoryPaths(node: RojoTreeNode, projectDirectory: string): void {
	for (const [key, value] of Object.entries(node)) {
		if (key === "$path" && typeof value === "string" && isDirectoryPath(node, value)) {
			const absolute = path.resolve(projectDirectory, value);
			if (!fs.existsSync(absolute)) {
				fs.mkdirSync(absolute, { recursive: true });
			}

			continue;
		}

		if (isRojoTreeNode(value) && !key.startsWith("$")) {
			collectDirectoryPaths(value, projectDirectory);
		}
	}
}

function ensurePackageDirectory(descriptor: PackageDescriptor): void {
	if (!fs.existsSync(descriptor.rojoProjectPath)) {
		return;
	}

	let project;
	try {
		project = loadRojoProject(descriptor.rojoProjectPath);
	} catch {
		return;
	}

	const projectDirectory = path.dirname(descriptor.rojoProjectPath);
	collectDirectoryPaths(project.tree, projectDirectory);
}
