import { type } from "arktype";
import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { isAbsolutePath, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { PNPM_MARKER } from "./discovery.ts";
import type { PackageInfo } from "./package-info.ts";

const STATE_PATH = path.join("node_modules", ".pnpm-workspace-state-v1.json");

// Only the two fields we read. pnpm adds top-level fields between versions
// (`pnpmfiles`, `settings`, `configDependencies`), so unknown keys are
// tolerated; a shape we could not read at all would arrive under a different
// filename, because the format version is part of the name.
//
// `name` is optional: pnpm records a project whose package.json omits one, and
// a package with no name is one `--packages` can never ask for.
const workspaceStateSchema = type({
	"+": "delete",
	"lastValidatedTimestamp": "number",
	// An index signature admits an array (its indices are string keys), and a
	// JSON array here means we are reading something other than the map pnpm
	// writes.
	"projects": type({
		"[string]": {
			"+": "delete",
			"name?": "string",
		},
	}).narrow((projects) => !Array.isArray(projects)),
});

/**
 * The workspace projects pnpm recorded during its last install, or `undefined`
 * when that record is absent, unreadable, or no longer trustworthy.
 *
 * pnpm enumerates the workspace itself on every install and writes the answer
 * to `node_modules/.pnpm-workspace-state-v1.json`. Reading it costs one
 * `readFile` where the glob path it replaces costs a full walk of the repo, and
 * it is the authority on questions that walk gets wrong: dot-directory
 * packages, `!` exclusions, and the root project.
 *
 * `undefined` means "ask the filesystem instead", never "no packages": every
 * guard here is a reason to distrust the snapshot, not evidence about the
 * workspace.
 */
export function readPnpmWorkspaceProjects(
	workspaceRoot: string,
	fileSystem: FileSystem = nodeFileSystem,
): Array<PackageInfo> | undefined {
	const state = readState(fileSystem, path.join(workspaceRoot, STATE_PATH));
	if (state === undefined) {
		return undefined;
	}

	if (!manifestPredatesInstall(fileSystem, workspaceRoot, state.lastValidatedTimestamp)) {
		return undefined;
	}

	const resolvedRoot = path.resolve(workspaceRoot);
	const packages: Array<PackageInfo> = [];
	for (const [directory, project] of Object.entries(state.projects)) {
		// `path.isAbsolute` is the right question here, unlike in `isInside`:
		// not "did some host call this absolute" but "can this process use it".
		// A `node_modules` carried across platforms records paths this one reads
		// as relative, and resolving those would silently graft them onto cwd.
		if (!path.isAbsolute(directory)) {
			return undefined;
		}

		const packageDirectory = path.resolve(directory);
		// A `node_modules` shared with another checkout records that
		// checkout's paths, which resolve to the wrong files here.
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
		// Absent, unreadable, and malformed all earn the same answer: this run
		// learns nothing from the snapshot and should ask the filesystem.
		return undefined;
	}

	const result = workspaceStateSchema(parsed);
	return result instanceof type.errors ? undefined : result;
}

/**
 * Whether the manifest that drives package selection still says what it said
 * when pnpm wrote the snapshot.
 *
 * mtime is coarse -- an unrelated edit (a catalog entry, a setting) also
 * invalidates -- and deliberately so: the cost of a false stale is one walk,
 * while the cost of a false fresh is a package the CLI cannot find.
 */
function manifestPredatesInstall(
	fileSystem: FileSystem,
	workspaceRoot: string,
	lastValidatedTimestamp: number,
): boolean {
	const stat = fileSystem.statSync(path.join(workspaceRoot, PNPM_MARKER), {
		throwIfNoEntry: false,
	});
	return stat !== undefined && stat.mtimeMs <= lastValidatedTimestamp;
}

/**
 * Both paths are already resolved absolutes. `isAbsolutePath` rather than
 * `path.isAbsolute` because a Windows path reads as relative on Linux, which
 * would let CI accept what a local run rejects.
 */
function isInside(resolvedParent: string, candidate: string): boolean {
	// The root relativizes to `""`, which satisfies both tests below, so it
	// needs no case of its own.
	const relative = normalizeWindowsPath(path.relative(resolvedParent, candidate));
	return !relative.startsWith("..") && !isAbsolutePath(relative);
}
