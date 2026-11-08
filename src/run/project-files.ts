import { applyExcludes } from "../config/apply-excludes.ts";
import { deriveTypecheckInclude } from "../config/derive-typecheck-include.ts";
import type { InstancePathResolver } from "../config/instance-path.ts";
import { narrowForLuauRun } from "../config/narrow-by-files.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { RelatedFileFilter } from "../related/related-tests.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { classifyTestFiles, discoverTestFiles } from "./discovery.ts";

/** The files one project runs, and its config narrowed to them. */
export interface ProjectSelection {
	/** Project config narrowed to the runtime files. */
	config: ResolvedConfig;
	/** Runtime test files the project has before the `related` filter. */
	runtimeCandidateCount: number;
	/** Runtime test files the project runs. */
	runtimeFiles: Array<string>;
	/** Type Test files the project checks. */
	typeTestFiles: Array<string>;
}

/** Inputs of {@link selectProjectFiles}. */
export interface ProjectSelectionInput {
	/** File system to discover on. */
	fileSystem: FileSystem;
	/** Filter of a `related` run; absent on any other run. */
	filterRelated: RelatedFileFilter | undefined;
	/** Project to select files for. */
	project: ResolvedProjectConfig;
	/** Positional files that apply to this project. */
	projectCliFiles: Array<string> | undefined;
	/** Places a file under the project's Rojo mounts. */
	toInstancePath: InstancePathResolver;
	/** Resolved typecheck config of the project. */
	typecheck: ResolvedTypecheckConfig;
}

interface ProjectFiles {
	isPositional: boolean;
	runtimeCandidateCount: number;
	runtimeFiles: Array<string>;
	typeTestFiles: Array<string>;
}

/**
 * Discover one project's test files, apply its excludes and the `related`
 * filter, and narrow its config to the runtime files that remain.
 *
 * @param input - Project, filters, typecheck config and file system.
 * @returns The selected files and the narrowed config.
 */
export function selectProjectFiles(input: ProjectSelectionInput): ProjectSelection {
	const { filterRelated, project, toInstancePath, typecheck } = input;
	const discoveryConfig = buildDiscoveryConfig(project, typecheck);
	const { isPositional, runtimeCandidateCount, runtimeFiles, typeTestFiles } =
		discoverProjectFiles({
			...input,
			discoveryConfig,
		});

	const isFilterActive =
		isPositional ||
		filterRelated !== undefined ||
		discoveryConfig.testPathPattern !== undefined;
	const narrowed = { ...discoveryConfig, testMatch: project.testMatch };
	return {
		config: narrowForLuauRun({
			config: narrowed,
			filterActive: isFilterActive,
			runtimeFiles,
			toInstancePath,
		}),
		runtimeCandidateCount,
		runtimeFiles,
		typeTestFiles,
	};
}

/**
 * Type Tests are discovered by `-d` globs derived from the Runtime `include`
 * (or an explicit `test.typecheck.include`). These stay in the local discovery
 * `testMatch` only — never folded into `project.include` — so coverage-source
 * derivation (which reads `project.include`) never sees a `-d` glob.
 *
 * @param project - Resolved project.
 * @param typecheck - Resolved typecheck config of the project.
 * @returns The project config with the discovery `testMatch`.
 */
function buildDiscoveryConfig(
	project: ResolvedProjectConfig,
	typecheck: ResolvedTypecheckConfig,
): ResolvedConfig {
	return {
		...project.config,
		projects: project.projects,
		testMatch: typecheck.enabled
			? [
					...project.include,
					...(typecheck.include ?? deriveTypecheckInclude(project.include)),
				]
			: project.include,
	};
}

function discoverProjectFiles({
	discoveryConfig,
	fileSystem,
	filterRelated,
	project,
	projectCliFiles,
	typecheck,
}: ProjectSelectionInput & { discoveryConfig: ResolvedConfig }): ProjectFiles {
	const discovered = discoverTestFiles({
		cliFiles: projectCliFiles,
		config: discoveryConfig,
		fileSystem,
	});
	const classified = classifyTestFiles(discovered.files, typecheck);

	// `exclude` globs only match the relative paths glob-discovery returns;
	// explicit positional files come back absolute and are user-chosen, so they
	// bypass `exclude` — mirroring how `testPathIgnorePatterns` is already
	// skipped for positionals in `discoverTestFiles`. Runtime files use the
	// project's `exclude`; type tests use `test.typecheck.exclude`.
	const isPositional = (projectCliFiles?.length ?? 0) > 0;
	function include(files: Array<string>, exclude: Array<string> | undefined): Array<string> {
		return isPositional ? files : applyExcludes(files, exclude);
	}

	function keepRelated(files: Array<string>): Array<string> {
		return filterRelated?.(files, discoveryConfig.rootDir) ?? files;
	}

	const runtimeCandidates = include(classified.runtimeFiles, project.exclude);
	return {
		isPositional,
		runtimeCandidateCount: runtimeCandidates.length,
		runtimeFiles: keepRelated(runtimeCandidates),
		typeTestFiles: keepRelated(include(classified.typeTestFiles, typecheck.exclude)),
	};
}
