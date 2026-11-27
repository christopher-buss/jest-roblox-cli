import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function absolutizeEscapingProjectPaths({
	sandboxDirectory,
	sourceDirectory,
}: {
	sandboxDirectory: string;
	sourceDirectory: string;
}): void {
	const projectFiles = findProjectFiles(sandboxDirectory);

	for (const relativeFile of projectFiles) {
		const projectFile = path.join(sandboxDirectory, relativeFile);
		const sourceResolved = path.resolve(sourceDirectory, path.dirname(relativeFile));
		const sandboxResolved = path.resolve(sandboxDirectory, path.dirname(relativeFile));
		const raw = JSON.parse(readFileSync(projectFile, "utf-8"));
		const before = JSON.stringify(raw);

		rewriteEscapingPaths(raw, sourceResolved, sandboxResolved);
		if (JSON.stringify(raw) !== before) {
			writeFileSync(projectFile, `${JSON.stringify(raw, null, "\t")}\n`);
		}
	}
}

function rewriteEscapingPaths(
	node: JSONValue,
	sourceResolved: string,
	sandboxResolved: string,
): void {
	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return;
	}

	const value = node["$path"];
	if (typeof value === "string" && !path.isAbsolute(value)) {
		const absolute = path.resolve(sourceResolved, value);
		const relativeFromSource = path.relative(sourceResolved, absolute);
		if (relativeFromSource.startsWith("..") || path.isAbsolute(relativeFromSource)) {
			const fromSandbox = path.relative(sandboxResolved, absolute).replaceAll("\\", "/");
			node["$path"] = fromSandbox;
		}
	}

	for (const child of Object.values(node)) {
		rewriteEscapingPaths(child, sourceResolved, sandboxResolved);
	}
}

function findProjectFiles(root: string, relativeDirectory = ""): Array<string> {
	return readdirSync(path.join(root, relativeDirectory), { withFileTypes: true }).flatMap(
		(entry) => {
			const relativePath = path.join(relativeDirectory, entry.name);
			if (entry.isDirectory() && entry.name !== "node_modules") {
				return findProjectFiles(root, relativePath);
			}

			return entry.isFile() && entry.name.endsWith(".project.json") ? [relativePath] : [];
		},
	);
}
