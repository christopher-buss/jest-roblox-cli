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

/**
 * Rojo project files use `$path` values relative to the project file. When a
 * fixture references siblings outside its own directory (e.g. `rojo-sync/`),
 * the relative path is calibrated to the fixture's location in the repo —
 * copying the fixture to a temp sandbox at a different depth breaks those
 * references. For each `$path` that escapes the source fixture, rewrite it
 * to a sandbox-relative path that points back at the original target.
 * Sandbox-relative (rather than absolute) lets downstream consumers like the
 * coverage rewriter still relocate the project tree without mangling the path.
 * @param root - Fixture root.
 * @param relativeDirectory - Directory under `root` to search.
 * @returns Project file paths relative to `root`.
 */
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
