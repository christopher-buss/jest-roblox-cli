import { type } from "arktype";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { PackageInfo } from "./package-resolver.ts";
import { PNPM_MARKER } from "./workspace-root.ts";

const STATE_PATH = path.join("node_modules", ".pnpm-workspace-state-v1.json");

const workspaceStateSchema = type({
	"+": "delete",
	"lastValidatedTimestamp": "number",
	"projects": type({
		"[string]": {
			"+": "delete",
			"name?": "string",
		},
	}).narrow((projects) => !Array.isArray(projects)),
});

/**
 * The workspace projects pnpm recorded during its last install.
 * @param workspaceRoot - Workspace root directory.
 * @param fileSystem - File system to read through.
 * @returns The recorded packages, or `undefined` when not trusted.
 */
export function readPnpmWorkspaceProjects(
	workspaceRoot: string,
	fileSystem: FileSystem,
): Array<PackageInfo> | undefined {
	const state = readState(fileSystem, path.join(workspaceRoot, STATE_PATH));
	if (
		state === undefined ||
		!manifestPredatesInstall({
			fileSystem,
			lastValidatedTimestamp: state.lastValidatedTimestamp,
			workspaceRoot,
		})
	) {
		return undefined;
	}

	const resolvedRoot = path.resolve(workspaceRoot);
	const packages: Array<PackageInfo> = [];
	for (const [directory, project] of Object.entries(state.projects)) {
		// Must stay `path.isAbsolute`: asks whether this host can use the path.
		if (!path.isAbsolute(directory)) {
			return undefined;
		}

		const packageDirectory = path.resolve(directory);
		if (!isInside(resolvedRoot, packageDirectory)) {
			return undefined;
		}

		const { name } = project;
		if (name !== undefined) {
			packages.push({ name, packageDirectory });
		}
	}

	return packages;
}

function readState(
	fileSystem: FileSystem,
	statePath: string,
): typeof workspaceStateSchema.infer | undefined {
	let parsed: JSONValue;
	try {
		parsed = JSON.parse(fileSystem.readFileSync(statePath, "utf-8"));
	} catch {
		return undefined;
	}

	const result = workspaceStateSchema(parsed);
	return result instanceof type.errors ? undefined : result;
}

function manifestPredatesInstall({
	fileSystem,
	lastValidatedTimestamp,
	workspaceRoot,
}: {
	readonly fileSystem: FileSystem;
	readonly lastValidatedTimestamp: number;
	readonly workspaceRoot: string;
}): boolean {
	const stat = fileSystem.statSync(path.join(workspaceRoot, PNPM_MARKER), {
		throwIfNoEntry: false,
	});
	return stat !== undefined && stat.mtimeMs <= lastValidatedTimestamp;
}

/**
 * Must stay `isAbsolutePath`: a Windows path reads as relative on Linux.
 *
 * @param resolvedParent - Absolute parent directory.
 * @param candidate - Absolute path to test.
 * @returns Whether `candidate` is `resolvedParent` or below it.
 */
function isInside(resolvedParent: string, candidate: string): boolean {
	const relative = normalizeWindowsPath(path.relative(resolvedParent, candidate));
	return !relative.startsWith("..") && !isAbsolutePath(relative);
}
