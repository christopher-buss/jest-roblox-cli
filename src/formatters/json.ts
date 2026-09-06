import * as path from "node:path";

import type { JestResult } from "../types/jest-result.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
}

export async function writeJsonFileAsync(
	result: JestResult,
	filePath: string,
	fileSystem: FileSystem = nodeFileSystem,
): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fileSystem.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fileSystem.promises.writeFile(absolutePath, formatJson(result), "utf8");
}
