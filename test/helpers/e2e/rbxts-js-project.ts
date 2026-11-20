import { type } from "arktype";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SCOPE = "@rbxts-js";
const GLOB_IGNORE_PATHS = ["**/.package-lock.json", "**/package.json", "**/tsconfig.json"];
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../..");
const NAME_COLLATOR = new Intl.Collator();

const manifestSchema = type({
	"name": "string",
	"dependencies?": "Record<string, string>",
});
const projectNameSchema = type({ "name?": "string" });

/**
 * Write `node_modules/@rbxts-js.project.json` into `directory`, mounting every
 * `@rbxts-js` package this package's installed `@rbxts/jest` reaches. A fixture
 * that mounts it then resolves Jest without the monorepo-root postinstall.
 * @param directory - Directory to write `node_modules/` into.
 */
export function writeRbxtsJsProject(directory: string): void {
	const jestManifest = createRequire(path.join(PACKAGE_ROOT, "package.json")).resolve(
		"@rbxts/jest/package.json",
	);
	const packages = collectScopePackages(realpathSync.native(path.dirname(jestManifest)));
	const tree: Record<string, string | { $path: string }> = { $className: "Folder" };
	const sorted = [...packages].toSorted(([left], [right]) => NAME_COLLATOR.compare(left, right));
	for (const [name, packageDirectory] of sorted) {
		tree[instanceName(packageDirectory, name.slice(SCOPE.length + 1))] = {
			$path: packageDirectory,
		};
	}

	const nodeModules = path.join(directory, "node_modules");
	mkdirSync(nodeModules, { recursive: true });
	writeFileSync(
		path.join(nodeModules, `${SCOPE}.project.json`),
		JSON.stringify({ name: SCOPE, globIgnorePaths: GLOB_IGNORE_PATHS, tree }, undefined, "\t"),
	);
}

function instanceName(directory: string, fallback: string): string {
	const projectFile = path.join(directory, "default.project.json");
	if (!existsSync(projectFile)) {
		return fallback;
	}

	const { name } = projectNameSchema.assert(JSON.parse(readFileSync(projectFile, "utf-8")));
	return name !== undefined && name.length > 0 ? name : fallback;
}

function containingNodeModules(directory: string, name: string): string {
	return name.startsWith("@") ? path.dirname(path.dirname(directory)) : path.dirname(directory);
}

function installedDependencies(directory: string): { dependencies: Array<string>; name: string } {
	const manifest = manifestSchema.assert(
		JSON.parse(readFileSync(path.join(directory, "package.json"), "utf-8")),
	);
	const dependencyRoot = containingNodeModules(directory, manifest.name);
	const dependencies = Object.keys(manifest.dependencies ?? {})
		.map((dependency) => path.join(dependencyRoot, dependency))
		.filter((installed) => existsSync(installed))
		.map((installed) => realpathSync.native(installed));
	return { name: manifest.name, dependencies };
}

function collectScopePackages(rootDirectory: string): Map<string, string> {
	const found = new Map<string, string>();
	const seen = new Set<string>();
	let pending = [rootDirectory];
	while (pending.length > 0) {
		const next: Array<string> = [];
		for (const directory of pending) {
			seen.add(directory);
			const { name, dependencies } = installedDependencies(directory);
			if (name.startsWith(`${SCOPE}/`) && !found.has(name)) {
				found.set(name, directory);
			}

			next.push(...dependencies);
		}

		pending = [...new Set(next)].filter((candidate) => !seen.has(candidate));
	}

	return found;
}
