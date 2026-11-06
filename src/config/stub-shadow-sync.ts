import { Buffer } from "node:buffer";
import path from "node:path";

import type { ShadowBake, ShadowLayout } from "../coverage-pipeline/spine.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import {
	isGeneratedStub,
	LEGACY_LUA_FILENAME,
	STUB_FILENAME,
	STUB_FILENAMES,
} from "./stub-files.ts";
import { assertMountContained } from "./stubs.ts";

interface SyncMountStubResult {
	changed: boolean;
	targetPath: string | undefined;
}

/** The shadow a stub is synced into, and the source tree it is read from. */
interface SyncTarget {
	fileSystem: FileSystem;
	rootDirectory: string;
	shadow: ShadowLayout;
}

/**
 * The bake half of a coverage prepare: mirror this run's cache stubs into the
 * shadow, and declare them so the shadow's orphan sweeps leave them be. See
 * {@link ShadowBake} for why the two travel as one.
 *
 * @param options - Cache root, projects and file system.
 * @returns The bake to run against the shadow.
 */
export function createStubBake({
	cacheRoot,
	fileSystem = nodeFileSystem,
	projects,
}: {
	readonly cacheRoot: string;
	readonly fileSystem?: FileSystem;
	readonly projects: Array<ResolvedProjectConfig>;
}): ShadowBake {
	return {
		isBakeOwned: (shadowPath) => isBakedStub(fileSystem, shadowPath),
		run: (shadow) => {
			return syncStubsToShadowDirectory({
				fileSystem,
				projects,
				rootDirectory: cacheRoot,
				shadow,
			});
		},
		stubMounts: (shadow) => {
			return projects.flatMap((project) => {
				return project.rojoMounts.flatMap((mount) => {
					const absStubPath = path.resolve(cacheRoot, mount.fsPath, STUB_FILENAME);
					return !shadow.isShadowed(mount.fsPath) && fileSystem.existsSync(absStubPath)
						? [{ absStubPath, dataModelPath: mount.dataModelPath }]
						: [];
				});
			});
		},
	};
}

/**
 * The mirror keeps a user's `jest.config.lua` in the shadow, and rojo builds it
 * beside a `.luau` stub as a second `jest.config`, so the stub takes its name.
 *
 * @param fileSystem - File system to read through.
 * @param mountedDirectory - Shadow directory the place mounts.
 * @returns The file name the stub is written to.
 */
function shadowStubFilename(fileSystem: FileSystem, mountedDirectory: string): string {
	const legacyPath = path.join(mountedDirectory, LEGACY_LUA_FILENAME);
	if (!fileSystem.existsSync(legacyPath)) {
		return STUB_FILENAME;
	}

	const isLuauAbsent = !fileSystem.existsSync(path.join(mountedDirectory, STUB_FILENAME));
	return isLuauAbsent || !isGeneratedStub(legacyPath, fileSystem)
		? LEGACY_LUA_FILENAME
		: STUB_FILENAME;
}

function syncMountStub({
	fileSystem,
	fsPath,
	project,
	rootDirectory,
	shadow,
}: SyncTarget & {
	readonly fsPath: string;
	readonly project: ResolvedProjectConfig;
}): SyncMountStubResult {
	assertMountContained({ fsPath, project, rootDirectory });
	if (!shadow.isShadowed(fsPath)) {
		return { changed: false, targetPath: undefined };
	}

	const sourcePath = path.resolve(rootDirectory, fsPath, STUB_FILENAME);
	if (!fileSystem.existsSync(sourcePath)) {
		return { changed: false, targetPath: undefined };
	}

	// Asked rather than joined onto the shadow root: a mount the coverage
	// narrowing demoted is served from its spine copy, and a stub baked into
	// the mirror beside it would be in a directory the place never mounts.
	const mountedDirectory = shadow.mountedDirectory(fsPath);
	const targetPath = path.resolve(
		mountedDirectory,
		shadowStubFilename(fileSystem, mountedDirectory),
	);
	const sourceContent = fileSystem.readFileSync(sourcePath);

	if (fileSystem.existsSync(targetPath)) {
		const targetContent = fileSystem.readFileSync(targetPath);
		if (Buffer.compare(sourceContent, targetContent) === 0) {
			return { changed: false, targetPath };
		}
	}

	fileSystem.mkdirSync(path.dirname(targetPath), { recursive: true });
	fileSystem.copyFileSync(sourcePath, targetPath);
	return { changed: true, targetPath };
}

function* findShadowStubs(fileSystem: FileSystem, directory: string): Generator<string, void> {
	if (!fileSystem.existsSync(directory)) {
		return;
	}

	const entries = fileSystem.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.resolve(directory, entry.name);
		if (entry.isDirectory()) {
			yield* findShadowStubs(fileSystem, fullPath);
		} else if (STUB_FILENAMES.has(entry.name)) {
			yield fullPath;
		}
	}
}

function removeEmptyParents({
	directory,
	fileSystem,
	stopAt,
}: {
	readonly directory: string;
	readonly fileSystem: FileSystem;
	readonly stopAt: string;
}): void {
	const resolved = path.resolve(directory);
	const resolvedStop = path.resolve(stopAt);
	if (resolved === resolvedStop || !resolved.startsWith(resolvedStop)) {
		return;
	}

	try {
		fileSystem.rmdirSync(resolved);
		removeEmptyParents({ directory: path.dirname(resolved), fileSystem, stopAt });
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Write each project mount's stub into the coverage shadow and delete orphan
 * generated stubs there; user-authored configs are kept.
 *
 * @param options - Projects, root directory, shadow layout and file system.
 * @returns True when any shadow file changed.
 */
function syncStubsToShadowDirectory({
	fileSystem = nodeFileSystem,
	projects,
	rootDirectory,
	shadow,
}: {
	/** File system to read and write through. */
	readonly fileSystem?: FileSystem;
	/** Projects whose mounts get stubs. */
	readonly projects: Array<ResolvedProjectConfig>;
	/** Root the project mount paths are relative to. */
	readonly rootDirectory: string;
	/** Coverage shadow to sync into. */
	readonly shadow: ShadowLayout;
}): boolean {
	let hasChanged = false;
	const expectedPaths = new Set<string>();
	const target = { fileSystem, rootDirectory, shadow };

	for (const project of projects) {
		for (const mount of project.rojoMounts) {
			const result = syncMountStub({ ...target, fsPath: mount.fsPath, project });
			if (result.targetPath !== undefined) {
				expectedPaths.add(result.targetPath);
			}

			hasChanged ||= result.changed;
		}
	}

	for (const existing of findShadowStubs(fileSystem, shadow.root)) {
		if (expectedPaths.has(existing)) {
			continue;
		}

		// `prepareCoverage` mirrors the source tree into the shadow before
		// this hook runs, so a user's `jest.config.luau` away from any mount
		// may land here. The orphan sweep deletes only marker-bearing stubs.
		if (!isGeneratedStub(existing, fileSystem)) {
			continue;
		}

		fileSystem.unlinkSync(existing);
		removeEmptyParents({ directory: path.dirname(existing), fileSystem, stopAt: shadow.root });
		hasChanged = true;
	}

	return hasChanged;
}

/**
 * The bake's own writes, as the shadow sees them. A user-authored config is
 * not one: it reaches the shadow through the mirror, which makes the sweeps
 * judge it by its source twin like any other copied file.
 *
 * @param fileSystem - File system to read through.
 * @param shadowPath - File to check, inside the shadow.
 * @returns True when the path is a stub file name with the generated header.
 */
function isBakedStub(fileSystem: FileSystem, shadowPath: string): boolean {
	return STUB_FILENAMES.has(path.basename(shadowPath)) && isGeneratedStub(shadowPath, fileSystem);
}
