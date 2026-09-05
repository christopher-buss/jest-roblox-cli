import * as path from "node:path";

import type { JestResult } from "../types/jest-result.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
}

// Awaits through `node:fs`'s own promises API rather than importing
// `node:fs/promises`: every spec that exercises an output sink mocks `node:fs`
// with memfs, and a second module specifier would slip past those mocks and
// write to the real disk.
export async function writeJsonFileAsync(
	result: JestResult,
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fileSystem.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fileSystem.promises.writeFile(absolutePath, formatJson(result), "utf8");
}
