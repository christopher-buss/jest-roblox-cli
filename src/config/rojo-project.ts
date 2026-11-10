import { findRojoProjectFile, type RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import type { ResolvedConfig } from "./resolved-config.ts";

const LAYOUT_PROJECT_FILE = ".jest-roblox-layout.project.json";

const JEST_PACKAGES_PROJECT = path.join("node_modules", "@rbxts-js.project.json");
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

/** Where {@link resolveRojoProject} looks. */
export interface RojoProjectOptions {
	/** Supplies the configured `rojoProject` and the `rootDir` it is under. */
	config: Pick<ResolvedConfig, "rojoProject" | "rootDir">;
	/** File taken as configured when the config names none. */
	defaultFile?: string | undefined;
	/** File system to search and to write a layout project to. */
	fileSystem: FileSystem;
}

/**
 * The Rojo project of a config: the configured file (or `defaultFile`), else a
 * project built from the file layout of a Luau-only package, else the project
 * file found under `rootDir`.
 *
 * @param options - Config, default file and file system.
 * @returns The absolute path, or undefined when there is none.
 */
export function resolveRojoProject({
	config,
	defaultFile,
	fileSystem,
}: RojoProjectOptions): string | undefined {
	const configured = config.rojoProject ?? defaultFile;
	if (configured !== undefined) {
		return path.resolve(config.rootDir, configured);
	}

	if (!fileSystem.existsSync(config.rootDir)) {
		return undefined;
	}

	return (
		writeLayoutProject(config.rootDir, fileSystem) ??
		findRojoProjectFile(config.rootDir, fileSystem)
	);
}

/**
 * Set `rojoProject` to the absolute path {@link resolveRojoProject} finds.
 *
 * @template T - The config shape.
 * @param config - Config to settle.
 * @param fileSystem - File system to search.
 * @returns The config with its Rojo project settled.
 */
export function withRojoProject<T extends Pick<ResolvedConfig, "rojoProject" | "rootDir">>(
	config: T,
	fileSystem: FileSystem,
): T {
	return { ...config, rojoProject: resolveRojoProject({ config, fileSystem }) };
}

/**
 * Settle a loaded config's Rojo project the way a run does.
 *
 * @param options - Config and file system.
 * @returns The config with `rojoProject` absolute, or unset when there is none.
 */
export function resolveLayoutProject({
	config,
	fileSystem,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
}): ResolvedConfig {
	return withRojoProject(config, fileSystem);
}

/**
 * The settled Rojo project of a config that needs one.
 *
 * @param config - Config whose `rojoProject` is settled.
 * @returns The absolute path.
 * @throws {Error} When the config has no Rojo project.
 */
export function requireRojoProject(config: Pick<ResolvedConfig, "rojoProject">): string {
	if (config.rojoProject !== undefined) {
		return config.rojoProject;
	}

	throw new Error(
		"No Rojo project found. Set rojoProject in config or add a .project.json file.",
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
			Workspace: {
				$className: "Workspace",
				$properties: { SignalBehavior: "Deferred" },
			},
		},
	};
}

function writeLayoutProject(rootDirectory: string, fileSystem: FileSystem): string | undefined {
	const files = fileSystem.readdirSync(rootDirectory, "utf-8");
	const isLuauOnly =
		!files.includes("tsconfig.json") &&
		files.every((file) => !file.endsWith(".project.json") || file === LAYOUT_PROJECT_FILE);
	if (!isLuauOnly) {
		return undefined;
	}

	const projectPath = path.join(rootDirectory, LAYOUT_PROJECT_FILE);
	fileSystem.writeFileSync(
		projectPath,
		JSON.stringify(buildLayoutProject(rootDirectory, fileSystem)),
	);
	return projectPath;
}
