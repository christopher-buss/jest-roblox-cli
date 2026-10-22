import * as path from "node:path";

import type { JestResult } from "../types/jest-result.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";

export interface WriteJsonFileOptions {
	filePath: string;
	fileSystem?: FileSystem;
	result: JestResult;
}

export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
}

export async function writeJsonFileAsync({
	filePath,
	fileSystem = nodeFileSystem,
	result,
}: WriteJsonFileOptions): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fileSystem.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fileSystem.promises.writeFile(absolutePath, formatJson(result), "utf8");
}
