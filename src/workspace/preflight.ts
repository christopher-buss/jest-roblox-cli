import { loadRojoProject } from "@isentinel/rojo-utils";

import * as fs from "node:fs";
import * as path from "node:path";

import { collectPaths } from "../utils/rojo-tree.ts";

export interface PackageDescriptor {
	name: string;
	packageDirectory: string;
	rojoProjectPath: string;
}

export interface PreflightError {
	package: string;
	reason: string;
}

export function validatePackages(descriptors: Array<PackageDescriptor>): Array<PreflightError> {
	const errors: Array<PreflightError> = [];
	for (const descriptor of descriptors) {
		validatePackage(descriptor, errors);
	}

	return errors;
}

function validatePackage(descriptor: PackageDescriptor, errors: Array<PreflightError>): void {
	if (!fs.existsSync(descriptor.rojoProjectPath)) {
		errors.push({
			package: descriptor.name,
			reason: `rojoProject not found at ${path.relative(descriptor.packageDirectory, descriptor.rojoProjectPath)}`,
		});
		return;
	}

	let project;
	try {
		project = loadRojoProject(descriptor.rojoProjectPath);
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
		const absolute = path.resolve(projectDirectory, relative);
		if (!fs.existsSync(absolute)) {
			errors.push({
				package: descriptor.name,
				reason: `$path target not found: ${relative}`,
			});
		}
	}
}
