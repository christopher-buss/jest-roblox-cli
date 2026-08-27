import * as path from "node:path";

import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { createRojoResolverCache, createSetupResolver } from "../config/setup-resolver.ts";
import { createGlobCache, globSync } from "../utils/glob.ts";

const DEFAULT_ROJO_PROJECT = "default.project.json";

// eslint-disable-next-line ts/no-inferrable-types -- isolatedDeclarations requires explicit annotation
export const TYPE_TEST_PATTERN: RegExp = /\.(test-d|spec-d)\.ts$/;

interface TestFileDiscovery {
	files: Array<string>;
	totalFiles: number;
}

interface ClassifiedTestFiles {
	runtimeFiles: Array<string>;
	typeTestFiles: Array<string>;
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

export function discoverTestFiles(
	config: ResolvedConfig,
	cliFiles?: Array<string>,
): TestFileDiscovery {
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
		const matches = globSync(pattern, { cache: globCache, cwd: config.rootDir });
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

export function classifyTestFiles(
	files: Array<string>,
	typecheck: ResolvedTypecheckConfig,
): ClassifiedTestFiles {
	const typeTestFiles = typecheck.enabled
		? files.filter((file) => TYPE_TEST_PATTERN.test(file))
		: [];
	const runtimeFiles = typecheck.only
		? []
		: files.filter((file) => !TYPE_TEST_PATTERN.test(file));
	return { runtimeFiles, typeTestFiles };
}

// `createSetupResolver` eagerly walks the rojo project tree (a full FS pass
// across every `$path`, including each `node_modules` package directory).
// On large repos this dominates host time, so multi-mode shares one resolver
// across all projects with the same rojo config -- typically every project.
// Per-project `rojoProject` overrides still get their own resolver.
//
// The walk itself is cached one layer down, keyed on the project path alone:
// two projects with different `rootDir` values still build different resolvers
// (each resolves relative paths against its own directory) but now share the
// one tree walk behind them.
export function resolveAllSetupFilePaths(configs: Array<ResolvedConfig>): void {
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
			resolve = createSetupResolver({
				cache: rojoCache,
				configDirectory: config.rootDir,
				rojoConfigPath,
			});
			resolvers.set(key, resolve);
		}

		if (config.setupFiles !== undefined) {
			config.setupFiles = config.setupFiles.map(resolve);
		}

		if (config.setupFilesAfterEnv !== undefined) {
			config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
		}
	}
}
