import * as fs from "node:fs";
import * as path from "node:path";

import type { GameOutputEntry } from "../types/game-output.ts";

export function formatGameOutputNotice(filePath: string, entryCount: number): string {
	if (entryCount === 0) {
		return "";
	}

	return `Game output (${String(entryCount)} entries) written to ${filePath}`;
}

export function parseGameOutput(raw: string | undefined): Array<GameOutputEntry> {
	if (raw === undefined) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return [];
		}

		return parsed as Array<GameOutputEntry>;
	} catch {
		return [];
	}
}

export function writeGameOutput(filePath: string, entries: Array<GameOutputEntry>): void {
	const absolutePath = path.resolve(filePath);
	const directoryPath = path.dirname(absolutePath);

	if (!fs.existsSync(directoryPath)) {
		fs.mkdirSync(directoryPath, { recursive: true });
	}

	fs.writeFileSync(absolutePath, JSON.stringify(entries, null, 2));
}
