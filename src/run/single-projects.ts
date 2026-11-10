import type { RojoTreeNode } from "@isentinel/rojo-utils";
import { loadRojoProject } from "@isentinel/rojo-utils";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { TypecheckCliOptions } from "../config/resolve-typecheck-config.ts";
import { resolveTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { requireRojoProject } from "../config/rojo-project.ts";
import { resolveAllSetupFilePaths } from "../config/setup-resolver.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { buildImplicitProject } from "./implicit-project.ts";
import type { RunSeams } from "./seams.ts";

/** Inputs of {@link resolveRunProjectsAsync}. */
export interface ResolveRunProjectsInput {
	/** Typecheck options from the CLI. */
	cliTypecheck: TypecheckCliOptions;
	/** Where the run reads. */
	fileSystem: FileSystem;
	/** Config with the CLI options merged in. */
	rootConfig: ResolvedConfig;
	/** Seams the projects resolve through. */
	seams: Pick<
		RunSeams,
		"childProcess" | "createSetupResolver" | "resolveAllProjects" | "tsconfigReader"
	>;
	/** Profiler of the run. */
	timing: TimingCollector;
}

/**
 * The configured projects, or the one implicit project a config without
 * `projects` runs, with their setup files resolved to Instance paths.
 * @param context - Layout inputs.
 * @returns Every resolved project.
 */
export async function resolveRunProjectsAsync(
	context: ResolveRunProjectsInput,
): Promise<Array<ResolvedProjectConfig>> {
	const projects = await resolveProjectConfigsAsync(context);
	context.timing.profile("resolveSetupFilePaths", () => {
		resolveAllSetupFilePaths({
			configs: projects.map((project) => project.config),
			createSetupResolver: context.seams.createSetupResolver,
			sourceOf: (config) => {
				return {
					configDirectory: config.rootDir,
					rojoConfigPath: requireRojoProject(config),
				};
			},
		});
	});
	return projects;
}

/**
 * Read and validate the Rojo project, then resolve its nested projects.
 * @param config - Config whose `rootDir` and `rojoProject` locate the file.
 * @param fileSystem - File system to read from; defaults to Node's.
 * @returns The resolved Rojo tree.
 * @throws {Error} When the file cannot be read or fails the Rojo schema.
 */
function loadRojoTree(config: ResolvedConfig, fileSystem: FileSystem): RojoTreeNode {
	return loadRojoProject(requireRojoProject(config), fileSystem).tree;
}

function resolveImplicitProject({
	cliTypecheck,
	fileSystem,
	rootConfig,
	seams,
	timing,
}: ResolveRunProjectsInput): ResolvedProjectConfig {
	const typecheck = resolveTypecheckConfig({ cli: cliTypecheck, root: rootConfig.typecheck });
	const rojoTree = typecheck.only
		? undefined
		: timing.profile("loadRojoTree", () => loadRojoTree(rootConfig, fileSystem));
	return buildImplicitProject({
		config: rootConfig,
		fileSystem,
		rojoTree,
		tsconfigReader: seams.tsconfigReader,
	});
}

async function resolveProjectConfigsAsync(
	context: ResolveRunProjectsInput,
): Promise<Array<ResolvedProjectConfig>> {
	const { fileSystem, rootConfig, seams, timing } = context;
	const rawProjects = rootConfig.projects;
	if (rawProjects === undefined || rawProjects.length === 0) {
		return [resolveImplicitProject(context)];
	}

	const rojoTree = timing.profile("loadRojoTree", () => loadRojoTree(rootConfig, fileSystem));
	return timing.profileAsync("resolveAllProjects", async () => {
		return seams.resolveAllProjects({
			childProcess: seams.childProcess,
			cwd: rootConfig.rootDir,
			entries: rawProjects,
			fileSystem,
			rojoTree,
			rootConfig,
			tsconfigReader: seams.tsconfigReader,
		});
	});
}
