import { parseYAML } from "confbox";
import * as fs from "node:fs";
import * as path from "node:path";

import { globSync } from "../utils/glob.ts";

export interface PackageInfo {
	name: string;
	packageDirectory: string;
}

interface PnpmWorkspace {
	packages?: Array<string>;
}

export function listPackages(workspaceRoot: string): Array<PackageInfo> {
	const yamlPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
	if (!fs.existsSync(yamlPath)) {
		throw new Error(
			"Workspace mode requires pnpm-workspace.yaml at the workspace root. " +
				"npm/yarn workspaces and turbo/nx-only workspaces are not yet supported.",
		);
	}

	const yaml = parseYAML<PnpmWorkspace>(fs.readFileSync(yamlPath, "utf-8"));
	const patterns = yaml.packages ?? [];

	const packages: Array<PackageInfo> = [];
	for (const pattern of patterns) {
		const packageJsonPattern = `${pattern.replace(/\/$/, "")}/package.json`;
		const matches = globSync(packageJsonPattern, { cwd: workspaceRoot });
		for (const match of matches) {
			const packageJsonPath = path.join(workspaceRoot, match);
			const packageDirectory = path.dirname(packageJsonPath);
			const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			if (
				typeof raw === "object" &&
				raw !== null &&
				!Array.isArray(raw) &&
				typeof raw["name"] === "string"
			) {
				packages.push({ name: raw["name"], packageDirectory });
			}
		}
	}

	return packages;
}

export function resolvePackage(workspaceRoot: string, name: string): PackageInfo {
	const candidates = listPackages(workspaceRoot);
	for (const candidate of candidates) {
		if (candidate.name === name) {
			return candidate;
		}
	}

	const names = candidates.map((candidate) => candidate.name).join(", ");
	throw new Error(`Package "${name}" not found in workspace. Available: ${names}`);
}
