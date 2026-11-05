import * as path from "node:path";

import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { createSetupResolver } from "../config/setup-resolver.ts";
import { applySetupResolver, createRojoResolverCache } from "../config/setup-resolver.ts";
import { isTypeTestFile } from "../typecheck/type-test-pattern.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { createGlobCache, globSync } from "../utils/glob.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";

/** Test files split by kind. */
export interface ClassifiedTestFiles {
	/** Files that run as runtime tests. */
	runtimeFiles: Array<string>;
	/** Files that run as Type Tests. */
	typeTestFiles: Array<string>;
}

/** Inputs of {@link discoverTestFiles}. */
export interface DiscoverTestFilesOptions {
	/** Positional files; when given, they replace the glob walk. */
	cliFiles?: Array<string> | undefined;
	/** Resolved config whose `testMatch` and ignore patterns apply. */
	config: ResolvedConfig;
	/** File system to glob; defaults to Node's. */
	fileSystem?: FileSystem | undefined;
}

interface TestFileDiscovery {
	files: Array<string>;
	totalFiles: number;
}

/**
 * Drop the files a `testPathPattern` regex does not select; `undefined` selects
 * everything.
 *
 * Shared rather than inlined at each call site: the two discovery paths glob
 * different things — this one walks `testMatch`, while workspace mode walks a
 * project's `include` (`discoverProjectTestFiles`) — but both have to read the
 * same pattern the same way, or a change to the matching rule lands in one
 * dispatch mode only.
 *
 * @param files - Candidate test file paths.
 * @param testPathPattern - Regex source, or `undefined`.
 * @returns The selected files.
 */
export function filterByTestPathPattern(
	files: Array<string>,
	testPathPattern: string | undefined,
): Array<string> {
	if (testPathPattern === undefined) {
		return files;
	}

	const pathPattern = new RegExp(testPathPattern);
	return files.filter((file) => pathPattern.test(file));
}

/**
 * Find the test files of a run, from positionals or the `testMatch` globs.
 *
 * @param options - CLI files, config and file system.
 * @param options.cliFiles - Positional files from the CLI.
 * @param options.config - Resolved config of the run.
 * @param options.fileSystem - File system to glob.
 * @returns Unique selected files and the count before `testPathPattern`.
 */
export function discoverTestFiles({
	cliFiles,
	config,
	fileSystem = nodeFileSystem,
}: DiscoverTestFilesOptions): TestFileDiscovery {
	if (cliFiles && cliFiles.length > 0) {
		const files = cliFiles.map((file) => path.resolve(config.rootDir, file));
		return { files, totalFiles: files.length };
	}

	const allFiles: Array<string> = [];
	// Every pattern walks the same rootDir, so one cache across the loop turns
	// a walk per testMatch entry into a single walk. Declaring the patterns up
	// front lets that walk keep only the files a `testMatch` can name, rather
	// than every file under `rootDir` — build output included.
	const globCache = createGlobCache(config.testMatch);
	for (const pattern of config.testMatch) {
		const matches = globSync(pattern, { cache: globCache, cwd: config.rootDir, fileSystem });
		allFiles.push(...matches);
	}

	const ignoredPatterns = config.testPathIgnorePatterns.map((pat) => new RegExp(pat));

	const baseFiles = allFiles.filter((file) => {
		return ignoredPatterns.every((pattern) => !pattern.test(file));
	});

	const uniqueBaseFiles = new Set(baseFiles);
	const totalFiles = uniqueBaseFiles.size;

	const filtered = filterByTestPathPattern(baseFiles, config.testPathPattern);
	return { files: [...new Set(filtered)], totalFiles };
}

/**
 * Split files into runtime and Type Test files by the typecheck mode.
 *
 * @param files - Test file paths.
 * @param typecheck - Resolved typecheck config.
 * @returns The runtime and Type Test files.
 */
export function classifyTestFiles(
	files: Array<string>,
	typecheck: ResolvedTypecheckConfig,
): ClassifiedTestFiles {
	const typeTestFiles = typecheck.enabled ? files.filter(isTypeTestFile) : [];
	const runtimeFiles = typecheck.only ? [] : files.filter((file) => !isTypeTestFile(file));
	return { runtimeFiles, typeTestFiles };
}

/**
 * `createSetupResolver` eagerly walks the rojo project tree (a full FS pass
 * across every `$path`, including each `node_modules` package directory).
 * On large repos this dominates host time, so multi-mode shares one resolver
 * across all projects with the same rojo config -- typically every project.
 * Per-project `rojoProject` overrides still get their own resolver.
 *
 * The walk itself is cached one layer down, keyed on the project path alone:
 * two projects with different `rootDir` values still build different resolvers
 * (each resolves relative paths against its own directory) but now share the
 * one tree walk behind them.
 *
 * @param configs - Configs whose setup file paths resolve in place.
 * @param createResolver - Factory of a setup-file resolver.
 */
export function resolveAllSetupFilePaths(
	configs: Array<ResolvedConfig>,
	createResolver: typeof createSetupResolver,
): void {
	const resolvers = new Map<string, (input: string) => string>();
	const rojoCache = createRojoResolverCache();

	for (const config of configs) {
		if (config.setupFiles === undefined && config.setupFilesAfterEnv === undefined) {
			continue;
		}

		const rojoConfigPath = path.resolve(
			config.rootDir,
			config.rojoProject ?? DEFAULT_ROJO_PROJECT,
		);
		const key = JSON.stringify([config.rootDir, rojoConfigPath]);
		let resolve = resolvers.get(key);
		if (resolve === undefined) {
			resolve = createResolver({
				cache: rojoCache,
				configDirectory: config.rootDir,
				rojoConfigPath,
			});
			resolvers.set(key, resolve);
		}

		applySetupResolver(config, resolve);
	}
}
