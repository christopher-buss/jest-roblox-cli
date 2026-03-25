import { loadConfig as c12LoadConfig } from "c12";
import * as path from "node:path";

import type { RojoTreeNode } from "../types/rojo.ts";
import { stripTsExtension } from "../utils/extensions.ts";
import { collectPaths } from "../utils/rojo-tree.ts";
import { ConfigError } from "./errors.ts";
import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";
import type { ProjectEntry, ProjectTestConfig, ResolvedConfig } from "./schema.ts";

export interface ResolvedProjectConfig {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	/** Original include patterns (with TS extensions) for filesystem discovery. */
	include: Array<string>;
	/** Resolved output directory (workspace-relative) for stub generation. */
	outDir?: string;
	/** DataModel paths for Jest execution. */
	projects: Array<string>;
	/** Luau-side testMatch patterns (extensions stripped). */
	testMatch: Array<string>;
}

export function extractStaticRoot(pattern: string): { glob: string; root: string } {
	const globChars = new Set(["*", "?", "[", "{"]);
	let firstGlobIndex = -1;

	for (const [index, char] of [...pattern].entries()) {
		if (globChars.has(char)) {
			firstGlobIndex = index;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		// No glob characters — treat entire pattern as root with empty glob
		const directory = path.posix.dirname(pattern);
		const base = path.posix.basename(pattern);
		return { glob: base, root: directory };
	}

	// Find last separator before first glob character
	const prefix = pattern.slice(0, firstGlobIndex);
	const lastSlash = prefix.lastIndexOf("/");

	if (lastSlash === -1) {
		throw new Error("Include pattern must have a static directory prefix");
	}

	return {
		glob: pattern.slice(lastSlash + 1),
		root: pattern.slice(0, lastSlash),
	};
}

export { stripTsExtension } from "../utils/extensions.ts";

export function extractProjectRoots(
	include: Array<string>,
): Array<{ root: string; testMatch: Array<string> }> {
	const rootMap = new Map<string, Array<string>>();

	for (const pattern of include) {
		const { glob, root } = extractStaticRoot(pattern);
		const stripped = stripTsExtension(glob);
		const qualified = stripped.includes("/") ? stripped : `**/${stripped}`;

		let patterns = rootMap.get(root);
		if (patterns === undefined) {
			patterns = [];
			rootMap.set(root, patterns);
		}

		patterns.push(qualified);
	}

	return [...rootMap.entries()].map(([root, testMatch]) => ({ root, testMatch }));
}

export function mapFsRootToDataModel(outDirectory: string, rojoTree: RojoTreeNode): string {
	const normalized = outDirectory.replace(/\/$/, "");
	const result = findInTree(rojoTree, normalized, "");
	if (result === undefined) {
		const available: Array<string> = [];
		collectPaths(rojoTree, available);

		let message = `No Rojo tree mapping found for path: ${normalized}`;
		if (available.length > 0) {
			message += `\n\nAvailable $path entries: ${available.join(", ")}`;
		}

		const hint = normalized.startsWith("src/")
			? 'Path starts with "src/" — if using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")'
			: undefined;

		throw new ConfigError(message, hint);
	}

	return result;
}

export function validateProjects(projects: Array<ProjectTestConfig>): void {
	const names = new Set<string>();

	for (const project of projects) {
		const name =
			typeof project.displayName === "string"
				? project.displayName
				: project.displayName.name;

		if (name === "") {
			throw new Error("Project must have a non-empty displayName");
		}

		if (names.has(name)) {
			throw new Error(`Duplicate project displayName: ${name}`);
		}

		names.add(name);

		if (project.include.length === 0) {
			throw new Error(`Project "${name}" must have at least one include pattern`);
		}
	}
}

const PROJECT_ONLY_KEYS: ReadonlySet<string> = new Set([
	"displayName",
	"exclude",
	"include",
	"outDir",
	"root",
]);

export function resolveProjectConfig(
	project: ProjectTestConfig,
	rootConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
): ResolvedProjectConfig {
	const roots = extractProjectRoots(project.include);
	const testMatch = roots.flatMap((entry) => entry.testMatch);
	const projectRoot = project.root;

	if (roots.length > 1 && project.outDir === undefined) {
		const name =
			typeof project.displayName === "string"
				? project.displayName
				: project.displayName.name;
		throw new Error(
			`Project "${name}" has multiple include roots but no outDir. ` +
				"Set outDir or split into separate projects.",
		);
	}

	const resolvedOutDirectory = resolveOutDirectory(project.outDir, projectRoot, roots[0]?.root);

	const dataModelPath =
		resolvedOutDirectory !== undefined
			? mapFsRootToDataModel(resolvedOutDirectory, rojoTree)
			: undefined;

	const resolvedInclude =
		projectRoot === undefined
			? project.include
			: project.include.map((pattern) => path.posix.join(projectRoot, pattern));

	const config = mergeProjectConfig(rootConfig, project);

	const displayName =
		typeof project.displayName === "string" ? project.displayName : project.displayName.name;
	const displayColor =
		typeof project.displayName === "string" ? undefined : project.displayName.color;

	return {
		config,
		displayColor,
		displayName,
		include: resolvedInclude,
		outDir: resolvedOutDirectory,
		projects: dataModelPath !== undefined ? [dataModelPath] : [],
		testMatch,
	};
}

export async function loadProjectConfigFile(
	filePath: string,
	cwd: string,
): Promise<ProjectTestConfig> {
	const luauConfigPath = findLuauConfigFile(filePath, cwd);
	if (luauConfigPath !== undefined) {
		return buildProjectConfigFromLuau(luauConfigPath, filePath);
	}

	let result;
	try {
		result = await c12LoadConfig<ProjectTestConfig>({
			name: "jest-project",
			configFile: filePath,
			configFileRequired: true,
			cwd,
			dotenv: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to load project config file ${filePath}: ${message}`, {
			cause: err,
		});
	}

	const { config } = result;

	const name =
		typeof config.displayName === "string" ? config.displayName : config.displayName.name;

	if (name === "") {
		throw new Error(`Project config file "${filePath}" must have a displayName`);
	}

	return config;
}

export async function resolveAllProjects(
	entries: Array<ProjectEntry>,
	rootConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	cwd: string,
): Promise<Array<ResolvedProjectConfig>> {
	const projects: Array<ProjectTestConfig> = [];

	for (const entry of entries) {
		if (typeof entry === "string") {
			const loaded = await loadProjectConfigFile(entry, cwd);
			projects.push(loaded);
		} else {
			projects.push(entry.test);
		}
	}

	validateProjects(projects);

	return projects.map((project) => resolveProjectConfig(project, rootConfig, rojoTree));
}

/** When outDir is omitted (pure Luau), falls back to include pattern's static root. */
function resolveOutDirectory(
	projectOutDirectory: string | undefined,
	projectRoot: string | undefined,
	fallbackRoot: string | undefined,
): string | undefined {
	const base = projectOutDirectory ?? fallbackRoot;
	if (base === undefined) {
		return undefined;
	}

	return projectRoot !== undefined ? path.posix.join(projectRoot, base) : base;
}

function mergeProjectConfig(
	rootConfig: ResolvedConfig,
	project: ProjectTestConfig,
): ResolvedConfig {
	// Start with all root config values, then override with project-level
	// values (excluding structural keys like include/displayName/root/outDir)
	const merged: Record<string, unknown> = { ...rootConfig };

	for (const [key, value] of Object.entries(project)) {
		if (!PROJECT_ONLY_KEYS.has(key) && value !== undefined) {
			merged[key] = value;
		}
	}

	return merged as unknown as ResolvedConfig;
}

const LUAU_BOOLEAN_KEYS: ReadonlyArray<keyof ProjectTestConfig> = [
	"automock",
	"clearMocks",
	"injectGlobals",
	"mockDataModel",
	"resetMocks",
	"resetModules",
	"restoreMocks",
];

const LUAU_NUMBER_KEYS: ReadonlyArray<keyof ProjectTestConfig> = [
	"slowTestThreshold",
	"testTimeout",
];

const LUAU_STRING_KEYS: ReadonlyArray<keyof ProjectTestConfig> = ["testEnvironment"];

const LUAU_STRING_ARRAY_KEYS: ReadonlyArray<keyof ProjectTestConfig> = [
	"setupFiles",
	"setupFilesAfterEnv",
];

function copyLuauOptionalFields(raw: Record<string, unknown>, config: ProjectTestConfig): void {
	const record = config as unknown as Record<string, unknown>;

	for (const key of LUAU_BOOLEAN_KEYS) {
		if (typeof raw[key] === "boolean") {
			record[key] = raw[key];
		}
	}

	for (const key of LUAU_NUMBER_KEYS) {
		if (typeof raw[key] === "number") {
			record[key] = raw[key];
		}
	}

	for (const key of LUAU_STRING_KEYS) {
		if (typeof raw[key] === "string") {
			record[key] = raw[key];
		}
	}

	for (const key of LUAU_STRING_ARRAY_KEYS) {
		if (Array.isArray(raw[key])) {
			record[key] = raw[key];
		}
	}
}

function buildProjectConfigFromLuau(
	luauConfigPath: string,
	directoryPath: string,
): ProjectTestConfig {
	const raw = loadLuauConfig(luauConfigPath);

	const { displayName } = raw;
	if (typeof displayName !== "string" || displayName === "") {
		throw new Error(`Luau config file "${luauConfigPath}" must have a displayName string`);
	}

	const testMatch = Array.isArray(raw["testMatch"])
		? (raw["testMatch"] as Array<string>)
		: undefined;

	// Derive include from testMatch — append .luau extension and prefix with
	// directory path
	const include =
		testMatch !== undefined
			? testMatch.map((pattern) => path.posix.join(directoryPath, `${pattern}.luau`))
			: [path.posix.join(directoryPath, "**/*.spec.luau")];

	const config: ProjectTestConfig = {
		displayName,
		include,
	};

	if (testMatch !== undefined) {
		config.testMatch = testMatch;
	}

	copyLuauOptionalFields(raw, config);

	return config;
}

function matchNodePath(
	childNode: RojoTreeNode,
	targetPath: string,
	childDataModelPath: string,
): string | undefined {
	const nodePath = childNode.$path;
	if (typeof nodePath !== "string") {
		return undefined;
	}

	const normalizedNodePath = nodePath.replace(/\/$/, "");
	if (normalizedNodePath === targetPath) {
		return childDataModelPath;
	}

	// Check if targetPath is nested under this $path
	if (targetPath.startsWith(`${normalizedNodePath}/`)) {
		const remainder = targetPath.slice(normalizedNodePath.length + 1);
		return `${childDataModelPath}/${remainder}`;
	}

	return undefined;
}

function findInTree(
	node: RojoTreeNode,
	targetPath: string,
	currentDataModelPath: string,
): string | undefined {
	for (const [key, value] of Object.entries(node)) {
		if (key.startsWith("$") || typeof value !== "object") {
			continue;
		}

		const childNode = value as RojoTreeNode;
		const childDataModelPath =
			currentDataModelPath === "" ? key : `${currentDataModelPath}/${key}`;

		const pathMatch = matchNodePath(childNode, targetPath, childDataModelPath);
		if (pathMatch !== undefined) {
			return pathMatch;
		}

		// Recurse into child
		const found = findInTree(childNode, targetPath, childDataModelPath);
		if (found !== undefined) {
			return found;
		}
	}

	return undefined;
}
