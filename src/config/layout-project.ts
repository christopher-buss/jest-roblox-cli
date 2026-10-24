import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ResolvedConfig } from "./schema.ts";

export const LAYOUT_PROJECT_FILE = ".jest-roblox-layout.project.json";

const JEST_PACKAGES_PROJECT = path.join("node_modules", "@rbxts-js.project.json");
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

interface LayoutProjectOptions {
	config: ResolvedConfig;
	fileSystem: FileSystem;
}

/**
 * Give a Luau-only package with no Rojo project one built from its file
 * layout, so a relative string require resolves the same in the place as on
 * disk. Each top-level directory mounts under `ReplicatedStorage/<package>`.
 */
export function resolveLayoutProject({ config, fileSystem }: LayoutProjectOptions): ResolvedConfig {
	if (!needsLayoutProject(config, fileSystem)) {
		return config;
	}

	const projectPath = path.join(config.rootDir, LAYOUT_PROJECT_FILE);
	const project = buildLayoutProject(config.rootDir, fileSystem);
	fileSystem.writeFileSync(projectPath, JSON.stringify(project));
	return { ...config, rojoProject: projectPath };
}

function needsLayoutProject(config: ResolvedConfig, fileSystem: FileSystem): boolean {
	if (config.rojoProject !== undefined) {
		return false;
	}

	const files = fileSystem.readdirSync(config.rootDir, "utf-8");
	return (
		!files.includes("tsconfig.json") &&
		files.every((file) => !file.endsWith(".project.json") || file === LAYOUT_PROJECT_FILE)
	);
}

function mountDirectories(rootDirectory: string, fileSystem: FileSystem): RojoTreeNode {
	const entries = fileSystem.readdirSync(rootDirectory, { withFileTypes: true });
	const mounts = entries
		.filter((entry) => entry.isDirectory())
		.filter((entry) => !entry.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(entry.name))
		.map((entry) => [entry.name, { $path: entry.name }] as const);

	return Object.fromEntries(mounts);
}

function findJestPackagesProject(
	rootDirectory: string,
	fileSystem: FileSystem,
): string | undefined {
	for (let directory = rootDirectory; ; directory = path.dirname(directory)) {
		const candidate = path.join(directory, JEST_PACKAGES_PROJECT);
		if (fileSystem.existsSync(candidate)) {
			return path.relative(rootDirectory, candidate).split(path.sep).join("/");
		}

		if (path.dirname(directory) === directory) {
			return undefined;
		}
	}
}

function buildLayoutProject(
	rootDirectory: string,
	fileSystem: FileSystem,
): { name: string; tree: RojoTreeNode } {
	const name = path.basename(rootDirectory);
	const replicatedStorage: RojoTreeNode = {
		[name]: { $className: "Folder", ...mountDirectories(rootDirectory, fileSystem) },
		$className: "ReplicatedStorage",
	};

	const jestPackages = findJestPackagesProject(rootDirectory, fileSystem);
	if (jestPackages !== undefined) {
		replicatedStorage["node_modules"] = {
			"$className": "Folder",
			"@rbxts-js": { $className: "Folder", $path: jestPackages },
		};
	}

	return {
		name,
		tree: {
			$className: "DataModel",
			ReplicatedStorage: replicatedStorage,
			ServerScriptService: {
				$className: "ServerScriptService",
				$properties: { LoadStringEnabled: true },
			},
		},
	};
}
