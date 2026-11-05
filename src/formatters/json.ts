import * as path from "node:path";

import type { JestResult } from "../types/jest-result-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

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
}

/**
 * Serialize a result as indented JSON.
 * @param result - Result to serialize.
 * @returns The JSON text.
 */
export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
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
}: WriteJsonFileOptions): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fileSystem.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fileSystem.promises.writeFile(absolutePath, formatJson(result), "utf8");
}
