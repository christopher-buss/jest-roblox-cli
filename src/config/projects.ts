import type { Mount, PathClassifier, RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";

import { stripTsExtension } from "../utils/extensions.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ProjectConfigInput } from "./project-config-file.ts";
import { loadProjectConfigFile } from "./project-config-file.ts";
import { createFsClassifier, resolveMounts } from "./project-mounts.ts";
import type { TypecheckConfig } from "./resolve-typecheck-config.ts";
import type {
	ProjectConfigFile,
	ProjectEntry,
	ProjectTestConfig,
	ResolvedConfig,
} from "./schema.ts";

const GLOB_CHARACTER = /[*?[{]/;

/** A project with its merged config, mounts and discovery patterns. */
export interface ResolvedProjectConfig {
	/** Root config with the project's overrides applied. */
	config: ResolvedConfig;
	/** Color from an object `displayName`. */
	displayColor?: string | undefined;
	/** Project name. */
	displayName: string;
	/**
	 * Root-prefixed `exclude` globs subtracted from Runtime Test discovery.
	 * Optional on the public type (back-compat for external constructors);
	 * `resolveProjectConfig` always populates it (defaulting to `[]`).
	 */
	exclude?: Array<string> | undefined;
	/**
	 * Original include patterns (with TS extensions) for filesystem discovery.
	 */
	include: Array<string>;
	/**
	 * Single resolved output directory (workspace-relative). Set only when
	 * resolution produced exactly one mount; undefined when the project spans
	 * multiple rojo mounts. Kept for back-compat; new code should consume
	 * `rojoMounts` instead.
	 */
	outDir?: string | undefined;
	/** DataModel paths Jest walks up from to discover test configs. */
	projects: Array<string>;
	/** Internal: FS↔DataModel pairs for stub generation and shadow sync. */
	rojoMounts: Array<Mount>;
	/** Luau-side testMatch patterns (extensions stripped). */
	testMatch: Array<string>;
	/**
	 * Raw per-project `test.typecheck`, merged via `resolveTypecheckConfig`.
	 */
	typecheck?: TypecheckConfig | undefined;
}

/** An include pattern split at its last static directory. */
export interface StaticRootPattern {
	/** Remainder after `root`. */
	glob: string;
	/** Static directory prefix. */
	root: string;
}

/**
 * Split an include pattern at the last `/` before its first glob character.
 *
 * @param pattern - Include pattern.
 * @returns The static root and the glob after it.
 * @throws If the glob has no static directory prefix.
 */
export function extractStaticRoot(pattern: string): StaticRootPattern {
	const firstGlobIndex = GLOB_CHARACTER.exec(pattern)?.index ?? -1;

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

/**
 * Group include patterns by static root as Luau-side `testMatch` patterns.
 *
 * @param include - Include patterns.
 * @returns One entry per root, with extension-stripped patterns.
 * @throws If a glob has no static directory prefix.
 */
function extractProjectRoots(include: Array<string>): Array<{
	/** Static directory prefix of the include patterns. */
	root: string;
	/** Luau-side patterns under `root`. */
	testMatch: Array<string>;
}> {
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

/**
 * Check the cross-project invariants a schema cannot: names present and
 * unique, and an `include` that survived derivation.
 *
 * @param projects - The project configs as loaded, before include is known.
 * @returns The same projects, now carrying an `include`.
 * @throws When a name is missing or duplicated, or a project selects no files.
 */
function validateProjects(projects: Array<ProjectConfigFile>): Array<ProjectTestConfig> {
	const names = new Set<string>();
	const validated: Array<ProjectTestConfig> = [];

	for (const project of projects) {
		const name = displayNameOf(project);

		if (name === "") {
			throw new Error("Project must have a non-empty displayName");
		}

		if (names.has(name)) {
			throw new Error(`Duplicate project displayName: ${name}`);
		}

		names.add(name);

		const { include } = project;
		if (include === undefined || include.length === 0) {
			throw new Error(`Project "${name}" must have at least one include pattern`);
		}

		validated.push({ ...project, include });
	}

	return validated;
}

function applyProjectRoot(include: Array<string>, projectRoot: string | undefined): Array<string> {
	if (projectRoot === undefined) {
		return include;
	}

	return include.map((pattern) => path.posix.join(projectRoot, pattern));
}

const PROJECT_ONLY_KEYS: ReadonlySet<string> = new Set([
	"displayName",
	"exclude",
	"include",
	"outDir",
	"root",
]);

/** Project entries to resolve, with the frame they resolve in. */
export interface ProjectResolutionRequest extends ProjectResolutionFrame {
	/** Project paths or inline project configs. */
	readonly entries: Array<ProjectEntry>;
	/** Config each project inherits from. */
	readonly rootConfig: ResolvedConfig;
}

/**
 * The frame a project resolves in: its rojo tree, its cwd, and what reads
 * them.
 */
interface ProjectResolutionFrame extends ProjectConfigInput {
	cwd: string;
	rojoTree: RojoTreeNode;
}

/**
 * Reject project names that match no project.
 *
 * @param requested - Names the user asked for.
 * @param available - Display names of the projects that exist.
 * @throws When a requested name matches no project.
 */
export function assertKnownProjectNames(
	requested: ReadonlyArray<string>,
	available: ReadonlySet<string>,
): void {
	const unknown = requested.filter((name) => !available.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown project name(s): ${unknown.join(", ")}. Available: ${[...available].join(", ")}`,
		);
	}
}

/**
 * Load, validate and resolve every project entry.
 *
 * @param options - Entries, root config, frame and load collaborators.
 * @returns The resolved projects, in entry order.
 * @rejects If a project fails to load, validate or map to mounts.
 */
export async function resolveAllProjects({
	cwd,
	entries,
	fileSystem = nodeFileSystem,
	rojoTree,
	rootConfig,
	...seams
}: ProjectResolutionRequest): Promise<Array<ResolvedProjectConfig>> {
	const loaded: Array<ProjectConfigFile> = [];
	const input: ProjectConfigInput = { ...seams, fileSystem };

	for (const entry of entries) {
		if (typeof entry === "string") {
			loaded.push(await loadProjectConfigFile({ cwd, filePath: entry, input }));
		} else {
			loaded.push(entry.test);
		}
	}

	const projects = validateProjects(loaded);

	const classify = createFsClassifier(cwd, fileSystem);
	return projects.map((project) => {
		return resolveProjectConfig({ classify, project, rojoTree, rootConfig });
	});
}

function displayNameOf(project: ProjectConfigFile): string {
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
	const merged: ResolvedConfig = { ...rootConfig };

	for (const [key, value] of Object.entries(project)) {
		if (value !== undefined && key !== "typecheck" && !PROJECT_ONLY_KEYS.has(key)) {
			Reflect.set(merged, key, value);
		}
	}

	return merged;
}

/**
 * Resolve one validated project against the root config and Rojo tree.
 *
 * @param options - Classifier, project, Rojo tree and root config.
 * @returns The resolved project.
 * @throws If an include has no static prefix or a root maps to no mount.
 */
function resolveProjectConfig({
	classify,
	project,
	rojoTree,
	rootConfig,
}: {
	/** Classifies file-system paths during mount auto-expand. */
	readonly classify: PathClassifier;
	/** Validated project config. */
	readonly project: ProjectTestConfig;
	/** Rojo project tree. */
	readonly rojoTree: RojoTreeNode;
	/** Config the project inherits from. */
	readonly rootConfig: ResolvedConfig;
}): ResolvedProjectConfig {
	const rootPrefixedInclude = applyProjectRoot(project.include, project.root);
	const rootPrefixedExclude = applyProjectRoot(project.exclude ?? [], project.root);
	const roots = extractProjectRoots(rootPrefixedInclude);
	const testMatch = [...new Set(roots.flatMap((entry) => entry.testMatch))];

	const displayName = displayNameOf(project);
	const rojoMounts = resolveMounts({ classify, displayName, project, rojoTree, roots });

	const projects = rojoMounts.map((mount) => mount.dataModelPath);
	const singleMount = rojoMounts.length === 1 ? rojoMounts[0] : undefined;

	const config = mergeProjectConfig(rootConfig, project);

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
