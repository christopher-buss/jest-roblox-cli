import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

interface GlobOptions {
	cwd?: string;
}

export function globSync(pattern: string, options: GlobOptions = {}): Array<string> {
	const cwd = options.cwd ?? process.cwd();
	const allFiles = walkDirectory(cwd, cwd);

	return allFiles.filter((file) => matchesGlobPattern(file, pattern));
}

function matchesGlobPattern(filePath: string, pattern: string): boolean {
	const regexPattern = pattern
		.replace(/\./g, "\\.")
		.replace(/\*\*\//g, "{{DOUBLESTAR_SLASH}}")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\{\{DOUBLESTAR_SLASH\}\}/g, "(.+/)?");

	return new RegExp(`^${regexPattern}$`).test(filePath);
}

function walkDirectory(directoryPath: string, baseDirectory: string): Array<string> {
	const results: Array<string> = [];

	try {
		const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(directoryPath, entry.name);
			const relativePath = path.relative(baseDirectory, fullPath).replace(/\\/g, "/");

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
