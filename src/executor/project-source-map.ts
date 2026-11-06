import { resolveNestedProjects } from "@isentinel/rojo-utils";

import { type } from "arktype";
import * as path from "node:path";

import type { ResolvedConfig } from "../config/schema.ts";
import { createSourceMapper, type SourceMapper } from "../source-mapper/index.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { rojoProjectSchema } from "../types/rojo.ts";
import type { TsconfigMapping } from "../types/tsconfig-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { resolveFromDirectory } from "../utils/normalize-windows-path.ts";
import { resolveRojoProjectFile } from "./snapshot-writer.ts";

/** A project's source mapper and the frame its Rojo mounts resolve in. */
export interface ProjectSourceMap {
	/** Directory of the Rojo project file, which relative mounts resolve in. */
	rojoDirectory: string;
	/** Maps DataModel paths and frames back to source. */
	sourceMapper: SourceMapper;
}

/**
 * Build the source mapper for a project's Rojo project file.
 * @param options - The project config, file system and tsconfig mappings.
 * @returns The source map, or undefined when the Rojo project is missing or invalid.
 */
export function buildProjectSourceMap({
	config,
	fileSystem,
	tsconfigMappings,
}: {
	config: ResolvedConfig;
	fileSystem: FileSystem;
	tsconfigMappings: ReadonlyArray<TsconfigMapping>;
}): ProjectSourceMap | undefined {
	const rojoProjectPath = resolveRojoProjectFile(config, fileSystem);
	if (rojoProjectPath === undefined || !fileSystem.existsSync(rojoProjectPath)) {
		return undefined;
	}

	try {
		const rojoProjectRaw = JSON.parse(fileSystem.readFileSync(rojoProjectPath, "utf-8"));
		const rojoResult = rojoProjectSchema(rojoProjectRaw);
		if (rojoResult instanceof type.errors) {
			return undefined;
		}

		const rojoDirectory = path.dirname(rojoProjectPath);
		const resolvedTree = resolveNestedProjects(
			{ rootDirectory: rojoDirectory, tree: rojoResult.tree },
			fileSystem,
		);

		return {
			rojoDirectory,
			sourceMapper: createSourceMapper({
				fileSystem,
				mappings: tsconfigMappings,
				rojoProject: { ...rojoResult, tree: resolvedTree },
				rootDirectory: rojoDirectory,
			}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Rewrite each DataModel `testFilePath` the mapper resolves to an absolute disk path.
 * @param result - The project's result, rewritten in place.
 * @param sourceMap - The project's source map; nothing is rewritten without one.
 */
export function resolveTestFilePaths(
	result: JestResult,
	sourceMap: ProjectSourceMap | undefined,
): void {
	if (sourceMap === undefined) {
		return;
	}

	const { rojoDirectory, sourceMapper } = sourceMap;
	for (const file of result.testResults) {
		const resolved = sourceMapper.resolveTestFilePath(file.testFilePath);
		if (resolved !== undefined) {
			file.testFilePath = resolveFromDirectory(rojoDirectory, resolved);
		}
	}
}
