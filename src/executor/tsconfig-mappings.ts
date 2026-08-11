import { type } from "arktype";
import { getTsconfig } from "get-tsconfig";
import * as fs from "node:fs";
import * as path from "node:path";

import { type TsconfigCompilerOptions, tsconfigShapeSchema } from "../config/tsconfig-schema.ts";
import type { TsconfigMapping } from "../types/tsconfig.ts";
import { isTsSource } from "../utils/extensions.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

const TSCONFIG_FILENAME = /^tsconfig.*\.json$/i;

export interface TsconfigDirectories {
	outDir: string | undefined;
	rootDir: string | undefined;
}

export function isLuauProject(
	testFiles: ReadonlyArray<string>,
	tsconfigMappings: ReadonlyArray<TsconfigMapping>,
): boolean {
	if (tsconfigMappings.length > 0) {
		return false;
	}

	if (testFiles.some((file) => isTsSource(file))) {
		return false;
	}

	return true;
}

export function readTsconfigMapping(tsconfigPath: string): TsconfigDirectories | undefined {
	try {
		const raw = tsconfigShapeSchema(JSON.parse(fs.readFileSync(tsconfigPath, "utf-8")));
		if (raw instanceof type.errors || raw.compilerOptions === undefined) {
			return undefined;
		}

		const mappings = parseTsconfigMappings(raw.compilerOptions);
		return mappings[0];
	} catch {
		return undefined;
	}
}

export function resolveAllTsconfigMappings(projectRoot: string): Array<TsconfigMapping> {
	const resolvedRoot = path.resolve(projectRoot);
	let files: Array<string>;
	try {
		files = fs.readdirSync(resolvedRoot).filter((file) => TSCONFIG_FILENAME.test(file));
	} catch {
		return [];
	}

	const seen = new Set<string>();
	const mappings: Array<TsconfigMapping> = [];

	for (const file of files) {
		const tsconfig = getTsconfig(resolvedRoot, file);
		const compilerOptions = tsconfig?.config.compilerOptions as
			| TsconfigCompilerOptions
			| undefined;
		if (compilerOptions?.outDir === undefined) {
			continue;
		}

		const parsed = parseTsconfigMappings(compilerOptions);
		for (const entry of parsed) {
			const key = `${entry.outDir}:${entry.rootDir}`;
			if (!seen.has(key)) {
				seen.add(key);
				mappings.push(entry);
			}
		}
	}

	// Longest outDir first for correct prefix matching
	mappings.sort((a, b) => b.outDir.length - a.outDir.length);

	return mappings;
}

export function resolveTsconfigDirectories(projectRoot: string): TsconfigDirectories {
	// Prefer tsconfig.lib.json (roblox-ts compilation config with correct outDir)
	// over tsconfig.json (which may point to type-checking outDir like out-tsc/)
	const tsconfig = getTsconfig(projectRoot, "tsconfig.lib.json") ?? getTsconfig(projectRoot);

	// Only use tsconfig if it lives within the project root — ignore
	// parent-directory tsconfigs that getTsconfig walks up to find.
	const tsconfigDirectory =
		tsconfig !== null ? path.dirname(path.resolve(tsconfig.path)) : undefined;
	const resolvedRoot = path.resolve(projectRoot);
	const isLocal = tsconfigDirectory?.startsWith(resolvedRoot) === true;

	if (!isLocal || tsconfig?.config.compilerOptions === undefined) {
		return { outDir: undefined, rootDir: undefined };
	}

	const outDirectory = tsconfig.config.compilerOptions.outDir ?? "out";
	const rootDirectory = tsconfig.config.compilerOptions.rootDir ?? "src";

	return {
		outDir: normalizeDirectoryPath(outDirectory),
		rootDir: normalizeDirectoryPath(rootDirectory),
	};
}

function normalizeDirectoryPath(directory: string): string {
	return normalizeWindowsPath(path.normalize(directory));
}

function parseTsconfigMappings(options: TsconfigCompilerOptions): Array<TsconfigMapping> {
	const outDirectory = normalizeDirectoryPath(options.outDir ?? "out");

	if (options.rootDirs !== undefined && options.rootDirs.length > 0) {
		// rootDirs creates a virtual merged root. Output preserves directory
		// names relative to their common ancestor. Compute the common ancestor
		// as the effective rootDir.
		const normalized = options.rootDirs.map((directory) => normalizeDirectoryPath(directory));
		const commonAncestor = normalized.reduce((ancestor, directory) => {
			const parts = ancestor.split("/");
			const directoryParts = directory.split("/");
			let common = 0;
			while (
				common < parts.length &&
				common < directoryParts.length &&
				parts[common] === directoryParts[common]
			) {
				common++;
			}

			return parts.slice(0, common).join("/");
		});
		return [{ outDir: outDirectory, rootDir: commonAncestor || "." }];
	}

	if (options.rootDir === null) {
		return [];
	}

	return [{ outDir: outDirectory, rootDir: normalizeDirectoryPath(options.rootDir ?? "src") }];
}
