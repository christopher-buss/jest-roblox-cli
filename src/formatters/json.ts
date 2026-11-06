import * as path from "node:path";

import type { JestResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { makeRelative } from "./shared.ts";

/**
 * Inputs of `writeJsonFileAsync`.
 */
export interface WriteJsonFileOptions {
	/**
	 * Destination, resolved against the working directory.
	 */
	filePath: string;
	/**
	 * File system to write through; defaults to Node's.
	 */
	fileSystem?: FileSystem;
	/**
	 * Result to serialize.
	 */
	result: JestResult;
	/**
	 * Root that test file paths are written relative to.
	 */
	rootDir: string;
}

/**
 * Serialize a result as indented JSON.
 * @param result - Result to serialize.
 * @param rootDirectory - Root that test file paths are written relative to;
 *   absent writes them as they are.
 * @returns The JSON text.
 */
export function formatJson(result: JestResult, rootDirectory?: string): string {
	if (rootDirectory === undefined) {
		return JSON.stringify(result, null, 2);
	}

	const testResults = result.testResults.map((file) => {
		return { ...file, testFilePath: makeRelative(file.testFilePath, rootDirectory) };
	});
	return JSON.stringify({ ...result, testResults }, null, 2);
}

/**
 * Write a result as indented JSON, creating parent directories.
 * @param options - Destination, file system and result.
 * @rejects When a directory or the file cannot be written.
 */
export async function writeJsonFileAsync({
	filePath,
	fileSystem = nodeFileSystem,
	result,
	rootDir,
}: WriteJsonFileOptions): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fileSystem.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fileSystem.promises.writeFile(absolutePath, formatJson(result, rootDir), "utf8");
}
