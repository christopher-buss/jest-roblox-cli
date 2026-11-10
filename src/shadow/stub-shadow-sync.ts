import { Buffer } from "node:buffer";
import path from "node:path";

import type { ResolvedProjectConfig } from "../config/projects.ts";
import {
	isGeneratedStub,
	LEGACY_LUA_FILENAME,
	STUB_FILENAME,
	STUB_FILENAMES,
} from "../staging/stub-files.ts";
import { assertMountContained } from "../staging/stubs.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ShadowBake, ShadowLayout } from "./spine.ts";

interface SyncMountStubResult {
	changed: boolean;
	targetPath: string | undefined;
}

interface SyncTarget {
	fileSystem: FileSystem;
	rootDirectory: string;
	shadow: ShadowLayout;
}

/**
 * Mirrors this run's cache stubs into the shadow and declares them as owned.
 * @param options - Cache root, projects and file system.
 * @returns The bake to run against the shadow.
 */
export function createStubBake({
	cacheRoot,
	fileSystem,
	projects,
}: {
	readonly cacheRoot: string;
	readonly fileSystem: FileSystem;
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
 * Rojo builds a mirrored `jest.config.lua` beside a `.luau` stub as a second
 * `jest.config`, so the stub takes its name.
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

	// Not joined onto the shadow root: a demoted mount is served from its
	// spine copy.
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

function syncStubsToShadowDirectory({
	fileSystem,
	projects,
	rootDirectory,
	shadow,
}: {
	readonly fileSystem: FileSystem;
	readonly projects: Array<ResolvedProjectConfig>;
	readonly rootDirectory: string;
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

		if (!isGeneratedStub(existing, fileSystem)) {
			continue;
		}

		fileSystem.unlinkSync(existing);
		removeEmptyParents({ directory: path.dirname(existing), fileSystem, stopAt: shadow.root });
		hasChanged = true;
	}

	return hasChanged;
}

function isBakedStub(fileSystem: FileSystem, shadowPath: string): boolean {
	return STUB_FILENAMES.has(path.basename(shadowPath)) && isGeneratedStub(shadowPath, fileSystem);
}
