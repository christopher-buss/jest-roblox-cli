import * as path from "node:path";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { RelatedFileFilter } from "../related/related-tests.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { type GlobCache, globSync } from "../utils/glob.ts";
import { toTypeTestPattern } from "../utils/test-file-kind.ts";
import { applyExcludes } from "./apply-excludes.ts";
import type { InstancePathResolver } from "./instance-path.ts";
import { narrowForLuauRun } from "./narrow-by-files.ts";
import { classifyTestFiles, filterByTestPathPattern } from "./test-files.ts";

/** The files one project runs, and its config narrowed to them. */
export interface ProjectSelection {
	/** Project config narrowed to the runtime files. */
	config: ResolvedConfig;
	/** Counted before testPathPattern to preserve empty-run validation. */
	discovered: number;
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
	/** Shared across project discovery to avoid repeating filesystem walks. */
	globCache?: GlobCache | undefined;
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
		discovered: runtimeCandidateCount + typeTestFiles.length,
		runtimeCandidateCount,
		runtimeFiles,
		typeTestFiles,
	};
}

/**
 * Type Tests are discovered by `-d` globs derived from the Runtime `include`
 * (or an explicit `test.typecheck.include`). These stay in the local discovery
 * `testMatch` only (never folded into `project.include`), so coverage-source
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
			? [...project.include, ...(typecheck.include ?? project.include.map(toTypeTestPattern))]
			: project.include,
	};
}

function keepSelected(
	files: Array<string>,
	{
		config,
		filterRelated,
	}: { config: ResolvedConfig; filterRelated: RelatedFileFilter | undefined },
): Array<string> {
	return (
		filterRelated?.(files, {
			rojoProjectPath: config.rojoProject,
			rootDirectory: config.rootDir,
		}) ?? files
	);
}

function matchesIgnore(pattern: string, file: string): boolean {
	const expression = new RegExp(pattern);
	return expression.test(file);
}

function discoverCandidates({
	discoveryConfig,
	fileSystem,
	globCache,
	projectCliFiles,
}: Pick<ProjectSelectionInput, "fileSystem" | "globCache" | "projectCliFiles"> & {
	discoveryConfig: ResolvedConfig;
}): { files: Array<string> } {
	const isPositional = projectCliFiles !== undefined && projectCliFiles.length > 0;
	const found = isPositional
		? projectCliFiles.map((file) => path.resolve(discoveryConfig.rootDir, file))
		: [
				...new Set(
					discoveryConfig.testMatch.flatMap((pattern) => {
						return globSync(pattern, {
							cache: globCache,
							cwd: discoveryConfig.rootDir,
							fileSystem,
						});
					}),
				),
			].filter((file) => {
				return discoveryConfig.testPathIgnorePatterns.every(
					(pattern) => !matchesIgnore(pattern, file),
				);
			});
	return { files: found };
}

function classifyCandidates(
	input: ProjectSelectionInput & { discoveryConfig: ResolvedConfig },
): ReturnType<typeof classifyTestFiles> {
	return classifyTestFiles(discoverCandidates(input).files, input.typecheck);
}

function discoverProjectFiles(
	input: ProjectSelectionInput & { discoveryConfig: ResolvedConfig },
): ProjectFiles {
	const { discoveryConfig, filterRelated, project, projectCliFiles, typecheck } = input;
	const classified = classifyCandidates(input);

	const isPositional = (projectCliFiles?.length ?? 0) > 0;
	function include(files: Array<string>, exclude: Array<string> | undefined): Array<string> {
		return isPositional ? files : applyExcludes(files, exclude);
	}

	const runtimeCandidates = include(classified.runtimeFiles, project.exclude);
	return {
		isPositional,
		runtimeCandidateCount: runtimeCandidates.length,
		runtimeFiles: keepSelected(
			isPositional
				? runtimeCandidates
				: filterByTestPathPattern(runtimeCandidates, discoveryConfig.testPathPattern),
			{ config: discoveryConfig, filterRelated },
		),
		typeTestFiles: keepSelected(
			isPositional
				? classified.typeTestFiles
				: filterByTestPathPattern(
						include(classified.typeTestFiles, typecheck.exclude),
						discoveryConfig.testPathPattern,
					),
			{ config: discoveryConfig, filterRelated },
		),
	};
}
