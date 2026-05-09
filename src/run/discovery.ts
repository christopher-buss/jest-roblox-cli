import * as path from "node:path";

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
	config: ResolvedConfig,
): ClassifiedTestFiles {
	const typeTestFiles = config.typecheck
		? files.filter((file) => TYPE_TEST_PATTERN.test(file))
		: [];
	const runtimeFiles = config.typecheckOnly
		? []
		: files.filter((file) => !TYPE_TEST_PATTERN.test(file));
	return { runtimeFiles, typeTestFiles };
}

export function resolveSetupFilePaths(config: ResolvedConfig): void {
	if (config.setupFiles === undefined && config.setupFilesAfterEnv === undefined) {
		return;
	}

	const rojoConfigPath = path.resolve(config.rootDir, config.rojoProject ?? DEFAULT_ROJO_PROJECT);
	const resolve = createSetupResolver({
		configDirectory: config.rootDir,
		rojoConfigPath,
	});

	if (config.setupFiles !== undefined) {
		config.setupFiles = config.setupFiles.map(resolve);
	}

	if (config.setupFilesAfterEnv !== undefined) {
		config.setupFilesAfterEnv = config.setupFilesAfterEnv.map(resolve);
	}
}
