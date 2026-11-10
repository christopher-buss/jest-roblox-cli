import process from "node:process";

import type { ResolvedConfig } from "../config/resolved-config.ts";
import { createSourceMapper, type SourceMapper } from "../source-mapper/index.ts";
import type { TsconfigMapping } from "../tsconfig/tsconfig-mappings.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import { errorMessage } from "../utils/error-message.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { resolveFromDirectory } from "../utils/normalize-windows-path.ts";
import { readProjectRojo } from "./project-rojo.ts";

/** A project's source mapper and the frame its Rojo mounts resolve in. */
export interface ProjectSourceMap {
	/** Directory relative Rojo mounts resolve in. */
	rojoDirectory: string;
	/** Maps DataModel paths and frames back to source. */
	sourceMapper: SourceMapper;
}

/**
 * Build the source mapper for a project's Rojo project file.
 * @param options - The project config, file system and tsconfig mappings.
 * @returns The source map, or undefined when the Rojo project is unusable.
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
	const read = readProjectRojo(config, fileSystem);
	if (read.kind === "missing") {
		return undefined;
	}

	if (read.kind === "failed") {
		process.stderr.write(
			`Warning: Cannot map sources - ${read.projectPath}: ${errorMessage(read.error)}\n`,
		);
		return undefined;
	}

	const { project, rojoDirectory } = read;
	return {
		rojoDirectory,
		sourceMapper: createSourceMapper({
			fileSystem,
			mappings: tsconfigMappings,
			rojoProject: project,
			rootDirectory: rojoDirectory,
		}),
	};
}

/**
 * Rewrite each resolvable `testFilePath` to an absolute disk path.
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
