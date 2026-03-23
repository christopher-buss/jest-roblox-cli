import * as fs from "node:fs";
import * as path from "node:path";

import type { JestResult } from "../types/jest-result.ts";

export function formatJson(result: JestResult): string {
	return JSON.stringify(result, null, 2);
}

export async function writeJsonFile(result: JestResult, filePath: string): Promise<void> {
	const absolutePath = path.resolve(filePath);
	const directoryPath = path.dirname(absolutePath);

	if (!fs.existsSync(directoryPath)) {
		fs.mkdirSync(directoryPath, { recursive: true });
	}

	fs.writeFileSync(absolutePath, formatJson(result), "utf8");
}
