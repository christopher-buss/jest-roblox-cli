import * as fs from "node:fs";
import * as path from "node:path";

import type { JestResult } from "../types/jest-result.ts";

export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
}

// Awaits through `node:fs`'s own promises API rather than importing
// `node:fs/promises`: every spec that exercises an output sink mocks `node:fs`
// with memfs, and a second module specifier would slip past those mocks and
// write to the real disk.
export async function writeJsonFileAsync(result: JestResult, filePath: string): Promise<void> {
	const absolutePath = path.resolve(filePath);

	await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.promises.writeFile(absolutePath, formatJson(result), "utf8");
}
