import * as path from "node:path";

import type { CopyIgnoreMatcher } from "../instrument/discover-files.ts";
import { isSkippedDirectory } from "../instrument/discover-files.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** True when a `beforeBuild` bake owns this shadow path. */
export type BakeOwnershipMatcher = (shadowPath: string) => boolean;

interface ReconcileOptions {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	shadowDir: string;
}

interface OrphanSweep {
	hasDeleted: boolean;
	wasRemoved: boolean;
}

interface PruneContext {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	shadowRoot: string;
}

export const COV_MAP_SUFFIX = ".cov-map.json";

/**
 * Best-effort deletion.
 * @param deleteEntry - Performs the deletion; may throw.
 * @returns `true` when `deleteEntry` did not throw.
 */
export function tryRemove(deleteEntry: () => void): boolean {
	let wasRemoved = false;
	try {
		deleteEntry();
		wasRemoved = true;
	} catch {}

	return wasRemoved;
}

/**
 * Drops every shadow entry whose source counterpart no longer exists.
 * Callers must run the mirror sync first, which creates the shadow root.
 * @param options - Root, shadow dir, filesystem and ignore and bake matchers.
 * @returns `true` when anything was removed, so the caller forces a place rebuild.
 */
export function reconcileShadowToSource({
	fileSystem,
	isBakeOwned,
	isCopyIgnored,
	luauRoot,
	shadowDir,
}: ReconcileOptions): boolean {
	const shadowRoot = normalizeWindowsPath(shadowDir);
	return pruneShadowDirectory(
		{ fileSystem, isBakeOwned, isCopyIgnored, luauRoot, shadowRoot },
		shadowRoot,
	);
}

function sourceTwinExists({
	fileSystem,
	luauRoot,
	relativePath,
}: {
	fileSystem: FileSystem;
	luauRoot: PosixRoot;
	relativePath: string;
}): boolean {
	if (relativePath.endsWith(COV_MAP_SUFFIX)) {
		const base = relativePath.slice(0, -COV_MAP_SUFFIX.length);
		return (
			fileSystem.existsSync(path.resolve(luauRoot, `${base}.luau`)) ||
			fileSystem.existsSync(path.resolve(luauRoot, `${base}.lua`))
		);
	}

	return fileSystem.existsSync(path.resolve(luauRoot, relativePath));
}

function isInstrumenterOutput(relativePath: string): boolean {
	return relativePath.endsWith(COV_MAP_SUFFIX);
}

function pruneOrphanFile({
	fileSystem,
	isBakeOwned,
	isCopyIgnored,
	luauRoot,
	relativePath,
	shadowPath,
}: PruneContext & { relativePath: string; shadowPath: string }): boolean {
	// Sidecars skip the copy-ignore list, as in `shouldSyncToShadow`.
	if (
		(isInstrumenterOutput(relativePath) || !isCopyIgnored(relativePath)) &&
		sourceTwinExists({ fileSystem, luauRoot, relativePath })
	) {
		return false;
	}

	if (isBakeOwned?.(shadowPath) === true) {
		return false;
	}

	return tryRemove(() => {
		fileSystem.unlinkSync(shadowPath);
	});
}

function pruneShadowDirectory(context: PruneContext, directory: string): boolean {
	const entries = context.fileSystem.readdirSync(directory, { withFileTypes: true });
	let hasDeleted = false;

	for (const entry of entries) {
		if (entry.isDirectory() && isSkippedDirectory(entry.name)) {
			continue;
		}

		const shadowPath = normalizeWindowsPath(path.join(directory, entry.name));
		const relativePath = shadowPath.slice(context.shadowRoot.length + 1);
		const wasRemoved = entry.isDirectory()
			? pruneChildDirectory({ ...context, relativePath, shadowPath })
			: pruneOrphanFile({ ...context, relativePath, shadowPath });

		if (wasRemoved) {
			hasDeleted = true;
		}
	}

	return hasDeleted;
}

function pruneOrphanLeaf({
	fileSystem,
	isBakeOwned,
	shadowPath,
}: {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher;
	shadowPath: string;
}): OrphanSweep {
	if (isBakeOwned(shadowPath)) {
		return { hasDeleted: false, wasRemoved: false };
	}

	const wasRemoved = tryRemove(() => {
		fileSystem.rmSync(shadowPath);
	});
	return { hasDeleted: wasRemoved, wasRemoved };
}

function pruneOrphanDirectory({
	directory,
	fileSystem,
	isBakeOwned,
}: {
	directory: string;
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher;
}): OrphanSweep {
	let hasDeleted = false;
	let isEmpty = true;

	const entries = fileSystem.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const shadowPath = normalizeWindowsPath(path.join(directory, entry.name));
		const child = entry.isDirectory()
			? pruneOrphanDirectory({ directory: shadowPath, fileSystem, isBakeOwned })
			: pruneOrphanLeaf({ fileSystem, isBakeOwned, shadowPath });

		hasDeleted ||= child.hasDeleted;
		isEmpty &&= child.wasRemoved;
	}

	if (!isEmpty) {
		return { hasDeleted, wasRemoved: false };
	}

	const wasRemoved = tryRemove(() => {
		fileSystem.rmSync(directory, { recursive: true });
	});
	return { hasDeleted: hasDeleted || wasRemoved, wasRemoved };
}

function pruneChildDirectory({
	relativePath,
	shadowPath,
	...context
}: PruneContext & { relativePath: string; shadowPath: string }): boolean {
	const { fileSystem, isBakeOwned, isCopyIgnored, luauRoot } = context;
	if (
		!isCopyIgnored(relativePath) &&
		fileSystem.existsSync(path.resolve(luauRoot, relativePath))
	) {
		return pruneShadowDirectory(context, shadowPath);
	}

	if (isBakeOwned === undefined) {
		return tryRemove(() => {
			fileSystem.rmSync(shadowPath, { recursive: true });
		});
	}

	return pruneOrphanDirectory({ directory: shadowPath, fileSystem, isBakeOwned }).hasDeleted;
}
