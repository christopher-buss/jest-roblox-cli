import type { Mount, PathClassifier, PathKind, RojoTreeNode } from "@isentinel/rojo-utils";
import { collectMounts, collectPaths, findInTree, pruneAncestors } from "@isentinel/rojo-utils";

import { loadConfig as c12LoadConfig } from "c12";
import fs from "node:fs";
import * as path from "node:path";

import type { TsconfigDirectories } from "../executor.ts";
import { resolveTsconfigDirectories } from "../executor.ts";
import { stripTsExtension } from "../utils/extensions.ts";
import { ConfigError } from "./errors.ts";
import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";
import type { TypecheckConfig } from "./resolve-typecheck-config.ts";
import type {
	InlineProjectConfig,
	ProjectEntry,
	ProjectTestConfig,
	ResolvedConfig,
} from "./schema.ts";

const TRAILING_SLASH = /\/$/;
const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;

export interface ResolvedProjectConfig {
	config: ResolvedConfig;
	displayColor?: string;
	displayName: string;
	/**
	 * Root-prefixed `exclude` globs subtracted from Runtime Test discovery.
	 * Optional on the public type (back-compat for external constructors);
	 * `resolveProjectConfig` always populates it (defaulting to `[]`).
	 */
	exclude?: Array<string>;
	/** Original include patterns (with TS extensions) for filesystem discovery. */
	include: Array<string>;
	/**
	 * Single resolved output directory (workspace-relative). Set only when
	 * resolution produced exactly one mount; undefined when the project spans
	 * multiple rojo mounts. Kept for back-compat; new code should consume
	 * `rojoMounts` instead.
	 */
	outDir?: string;
	/** DataModel paths Jest walks up from to discover test configs. */
	projects: Array<string>;
	/** Internal: FS↔DataModel pairs for stub generation and shadow sync. */
	rojoMounts: Array<Mount>;
	/** Luau-side testMatch patterns (extensions stripped). */
	testMatch: Array<string>;
	/** Raw per-project `test.typecheck`, merged via `resolveTypecheckConfig`. */
	typecheck?: TypecheckConfig;
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

export function mapFsRootToDataModel(outDirectory: string, rojoTree: RojoTreeNode): string {
	const normalized = outDirectory.replace(TRAILING_SLASH, "");
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

	return Array.from(rootMap, ([root, testMatch]) => ({ root, testMatch }));
}

export function applyProjectRoot(
	include: Array<string>,
	projectRoot: string | undefined,
): Array<string> {
	if (projectRoot === undefined) {
		return include;
	}

	return include.map((pattern) => path.posix.join(projectRoot, pattern));
}

export function createFsClassifier(rootDirectory: string): PathClassifier {
	return function classify(fsPath: string): PathKind {
		const absolute = path.isAbsolute(fsPath) ? fsPath : path.resolve(rootDirectory, fsPath);
		const stat = fs.statSync(absolute, { throwIfNoEntry: false });
		if (stat === undefined) {
			return "missing";
		}

		return stat.isDirectory() ? "directory" : "file";
	};
}

export function validateProjects(projects: Array<ProjectTestConfig>): void {
	const names = new Set<string>();

	for (const project of projects) {
		const name = displayNameOf(project);

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

export function dedupeMounts(mounts: Array<Mount>): Array<Mount> {
	const seen = new Set<string>();
	const result: Array<Mount> = [];
	for (const mount of mounts) {
		if (seen.has(mount.dataModelPath)) {
			continue;
		}

		seen.add(mount.dataModelPath);
		result.push(mount);
	}

	return result;
}

export function resolveProjectConfig(
	project: ProjectTestConfig,
	rootConfig: ResolvedConfig,
	rojoTree: RojoTreeNode,
	classify: PathClassifier,
): ResolvedProjectConfig {
	const rootPrefixedInclude = applyProjectRoot(project.include, project.root);
	const rootPrefixedExclude = applyProjectRoot(project.exclude ?? [], project.root);
	const roots = extractProjectRoots(rootPrefixedInclude);
	const testMatch = [...new Set(roots.flatMap((entry) => entry.testMatch))];

	const rojoMounts = resolveMounts(project, roots, rojoTree, classify);

	const projects = rojoMounts.map((mount) => mount.dataModelPath);
	const singleMount = rojoMounts.length === 1 ? rojoMounts[0] : undefined;

	const config = mergeProjectConfig(rootConfig, project);

	const displayName = displayNameOf(project);
	const displayColor =
		typeof project.displayName === "string" ? undefined : project.displayName.color;

	return {
		config,
		displayColor,
		displayName,
		exclude: rootPrefixedExclude,
		include: rootPrefixedInclude,
		outDir: singleMount?.fsPath,
		projects,
		rojoMounts,
		testMatch,
		typecheck: project.typecheck,
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
		result = await c12LoadConfig<InlineProjectConfig | ProjectTestConfig>({
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

	const config = unwrapProjectConfig(result.config);

	const name =
		typeof config.displayName === "string" ? config.displayName : config.displayName.name;

	if (name === "") {
		throw new Error(`Project config file "${filePath}" must have a displayName`);
	}

	const configDirectory = path.posix.dirname(filePath);
	const tsconfig = resolveTsconfigDirectories(cwd);
	deriveIncludeFromTestMatch(config, configDirectory, tsconfig);

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
			projects.push(await loadProjectConfigFile(entry, cwd));
		} else {
			projects.push(entry.test);
		}
	}

	validateProjects(projects);

	const classify = createFsClassifier(cwd);
	return projects.map((project) => resolveProjectConfig(project, rootConfig, rojoTree, classify));
}

function displayNameOf(project: ProjectTestConfig): string {
	return typeof project.displayName === "string" ? project.displayName : project.displayName.name;
}

function mergeProjectConfig(
	rootConfig: ResolvedConfig,
	project: ProjectTestConfig,
): ResolvedConfig {
	// Start with all root config values, then override with project-level
	// values (excluding structural keys like include/displayName/root/outDir).
	// `typecheck` is resolved separately via `resolveTypecheckConfig` (a layered
	// merge), so it must not be wholesale-replaced here.
	const merged: Record<string, unknown> = { ...rootConfig };

	for (const [key, value] of Object.entries(project)) {
		if (!PROJECT_ONLY_KEYS.has(key) && key !== "typecheck" && value !== undefined) {
			merged[key] = value;
		}
	}

	return merged as unknown as ResolvedConfig;
}

function joinProjectRoot(relativePath: string, projectRoot: string | undefined): string {
	return projectRoot !== undefined ? path.posix.join(projectRoot, relativePath) : relativePath;
}

function pruneAncestorMounts(mounts: Array<Mount>): Array<Mount> {
	const dataModelPaths = mounts.map((mount) => mount.dataModelPath);
	const surviving = new Set(pruneAncestors(dataModelPaths));
	return mounts.filter((mount) => surviving.has(mount.dataModelPath));
}

function unmappableRootError(
	project: ProjectTestConfig,
	root: string,
	rojoTree: RojoTreeNode,
): ConfigError {
	const name = displayNameOf(project);
	const available: Array<string> = [];
	collectPaths(rojoTree, available);

	let message = `Project "${name}": include root "${root}" did not match any Rojo $path entry or subdirectory.`;
	if (available.length > 0) {
		message += `\n\nAvailable $path entries: ${available.join(", ")}`;
	}

	const hint = root.startsWith("src/")
		? 'Path starts with "src/" — if using roblox-ts, set "outDir" in your project config to the compiled output directory (e.g. "out/client")'
		: undefined;

	return new ConfigError(message, hint);
}

function filterMountsForRoot(allMounts: Array<Mount>, root: string): Array<Mount> {
	return allMounts.filter(
		(mount) => mount.fsPath === root || mount.fsPath.startsWith(`${root}/`),
	);
}

function resolveMounts(
	project: ProjectTestConfig,
	roots: Array<{ root: string; testMatch: Array<string> }>,
	rojoTree: RojoTreeNode,
	classify: PathClassifier,
): Array<Mount> {
	if (project.outDir !== undefined) {
		// Exact-lookup only; disables auto-expand. With outDir set, multi-root
		// includes feed test discovery only; the project stays pinned to one
		// DataModel mount.
		const resolvedOutDirectory = joinProjectRoot(project.outDir, project.root);
		const dataModelPath = mapFsRootToDataModel(resolvedOutDirectory, rojoTree);
		return [{ dataModelPath, fsPath: resolvedOutDirectory }];
	}

	// Walk the tree at most once; auto-expand filters this list per root
	// instead of re-walking for every unmatched include root.
	let collectedMounts: Array<Mount> | undefined;
	const allMounts: Array<Mount> = [];
	for (const { root } of roots) {
		const exact = findInTree(rojoTree, root, "");
		if (exact !== undefined) {
			allMounts.push({ dataModelPath: exact, fsPath: root });
			continue;
		}

		collectedMounts ??= collectMounts(rojoTree, "", classify);
		const expanded = filterMountsForRoot(collectedMounts, root);
		if (expanded.length === 0) {
			throw unmappableRootError(project, root, rojoTree);
		}

		allMounts.push(...expanded);
	}

	return pruneAncestorMounts(dedupeMounts(allMounts));
}

function isInlineProjectConfig(config: unknown): config is InlineProjectConfig {
	if (typeof config !== "object" || config === null || !("test" in config)) {
		return false;
	}

	const { test } = config as { test?: unknown };
	return typeof test === "object" && test !== null;
}

function unwrapProjectConfig(config: InlineProjectConfig | ProjectTestConfig): ProjectTestConfig {
	if (isInlineProjectConfig(config)) {
		return config.test;
	}

	return config;
}

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

/**
 * When a project config provides `testMatch` but not `include`, derive
 * `include` by appending `.ts` and `.tsx` extensions.  This lets users
 * write project configs with the standard Jest `testMatch` field without
 * needing the CLI-specific `include`.
 */
function deriveIncludeFromTestMatch(
	config: ProjectTestConfig,
	configDirectory: string,
	tsconfig: TsconfigDirectories,
): void {
	const raw = config as unknown as Record<string, unknown>;

	if (raw["include"] !== undefined) {
		return;
	}

	if (!Array.isArray(raw["testMatch"])) {
		return;
	}

	config.include = (raw["testMatch"] as Array<string>).flatMap((pattern) => {
		const withExtensions = TS_OR_LUAU_EXTENSION.test(pattern)
			? [pattern]
			: [`${pattern}.ts`, `${pattern}.tsx`];

		return withExtensions.map((extension) => path.posix.join(configDirectory, extension));
	});

	// Derive outDir from tsconfig rootDir/outDir mapping so the Rojo tree
	// mapping resolves correctly (e.g. src/shared → out/shared).
	const { outDir, rootDir } = tsconfig;
	if (raw["outDir"] === undefined && rootDir !== undefined && outDir !== undefined) {
		const rootPrefix = `${rootDir}/`;
		if (configDirectory.startsWith(rootPrefix)) {
			config.outDir = `${outDir}/${configDirectory.slice(rootPrefix.length)}`;
		}
	}
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
