import * as path from "node:path";

import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { createSetupResolver } from "../config/setup-resolver.ts";
import { globSync } from "../utils/glob.ts";

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

export function discoverTestFiles(
	config: ResolvedConfig,
	cliFiles?: Array<string>,
): TestFileDiscovery {
	if (cliFiles && cliFiles.length > 0) {
		const files = cliFiles.map((file) => path.resolve(config.rootDir, file));
		return { files, totalFiles: files.length };
	}

	const allFiles: Array<string> = [];
	for (const pattern of config.testMatch) {
		const matches = globSync(pattern, { cwd: config.rootDir });
		allFiles.push(...matches);
	}

	const ignoredPatterns = config.testPathIgnorePatterns.map((pat) => new RegExp(pat));

	const baseFiles = allFiles.filter((file) => {
		return !ignoredPatterns.some((pattern) => pattern.test(file));
	});

	const totalFiles = new Set(baseFiles).size;

	let filtered: Array<string> = baseFiles;
	if (config.testPathPattern !== undefined) {
		const pathPattern = new RegExp(config.testPathPattern);
		filtered = filtered.filter((file) => pathPattern.test(file));
	}

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
export function resolveAllSetupFilePaths(configs: Array<ResolvedConfig>): void {
	const resolvers = new Map<string, (input: string) => string>();

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
			resolve = createSetupResolver({ configDirectory: config.rootDir, rojoConfigPath });
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

export function resolveSetupFilePaths(config: ResolvedConfig): void {
	resolveAllSetupFilePaths([config]);
}
