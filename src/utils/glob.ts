import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { normalizeWindowsPath } from "./normalize-windows-path.ts";

interface GlobOptions {
	cwd?: string;
}

export function matchesGlobPattern(filePath: string, pattern: string): boolean {
	const regexPattern = pattern
		// Escape regex metacharacters (incl. `.`) so they match literally; the
		// glob wildcards `*`/`**` are translated below and are left untouched.
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\//g, "{{DOUBLESTAR_SLASH}}")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLESTAR_SLASH\}\}/g, "(.+/)?");

	return new RegExp(`^${regexPattern}$`).test(filePath);
}

export function globSync(pattern: string, options: GlobOptions = {}): Array<string> {
	const cwd = options.cwd ?? process.cwd();
	const allFiles = walkDirectory(cwd, cwd);

	return allFiles.filter((file) => matchesGlobPattern(file, pattern));
}

function walkDirectory(directoryPath: string, baseDirectory: string): Array<string> {
	const results: Array<string> = [];

	try {
		const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(directoryPath, entry.name);
			const relativePath = normalizeWindowsPath(path.relative(baseDirectory, fullPath));

			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
					results.push(...walkDirectory(fullPath, baseDirectory));
				}
			} else {
				results.push(relativePath);
			}
		}
	} catch {
		// Ignore permission errors
	}

	return results;
}
