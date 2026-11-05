import * as path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { CopyIgnoreMatcher } from "./discover-files.ts";
import { isSkippedDirectory } from "./discover-files.ts";

/**
 * Does a `beforeBuild` bake own this shadow path?
 *
 * A bake writes into the shadow once the mirror has already run, so what it
 * writes has no counterpart in the source root and every orphan sweep reads it
 * as one. Deleting it would only be undone by the bake moments later, with the
 * delete and the rewrite both reporting a change — a place rebuilt on every
 * run and a buildId that never settles. So a bake declares what it owns and
 * sweeps its own stale entries; a run without one declares nothing, and the
 * sweeps clear whatever an earlier bake left in a shared shadow.
 */
export type BakeOwnershipMatcher = (shadowPath: string) => boolean;

/** What the reconcile needs of one root, before it names the shadow tree. */
interface ReconcileOptions {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	shadowDir: string;
}

/** What one entry of an orphaned subtree left behind. */
interface OrphanSweep {
	hasDeleted: boolean;
	/** Whether the entry itself is gone, which is what frees its parent. */
	wasRemoved: boolean;
}

/** What the reconcile walk holds constant across the whole tree. */
interface PruneContext {
	fileSystem: FileSystem;
	isBakeOwned: BakeOwnershipMatcher | undefined;
	isCopyIgnored: CopyIgnoreMatcher;
	luauRoot: PosixRoot;
	/** Shadow root every relative path is keyed from, POSIX-normalized. */
	shadowRoot: string;
}

export const COV_MAP_SUFFIX = ".cov-map.json";

/**
 * Best-effort deletion: something we cannot remove stays put rather than being
 * reported as gone, so the caller never rebuilds the place over a lie.
 *
 * Exported for the spine prune, which clears the same shadow under the same
 * contract.
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
 * Reconcile a warm shadow dir against its source root: drop every shadow entry
 * whose source counterpart no longer exists. One rule covers files and
 * directories alike, so a warm run converges on what a cold run would have
 * produced.
 *
 * Files are the common case, across every category the pipeline manages —
 * instrumented prod `.luau`, spec/test/snap, and non-luau rojo files
 * (`init.meta.json`, `*.model.json`, …). Diffing against source (rather than a
 * recorded file set) means a file category the sync never tracked still gets
 * cleaned up, so a stale `init.meta.json` cannot survive into the rojo build
 * and fail it. `.cov-map.json` sidecars are instrumenter output with no 1:1
 * source twin; they map back to their base `.luau`/`.lua`.
 *
 * Directories matter for one shape rojo cannot tolerate: a `foo/index.ts` ->
 * `foo.ts` rename leaves the shadow holding a stale `foo/` beside the fresh
 * `foo.luau`, which rojo mounts as a Folder and a ModuleScript both named `foo`
 * under one parent. An empty *source* directory is legitimate — a cold run
 * mirrors it and rojo makes a Folder — so a directory is judged on whether its
 * source counterpart exists, never on whether it still holds anything.
 *
 * The one exception is a generated `jest.config.luau` on a run whose
 * `beforeBuild` bakes them: those are copied in from the cache root after this
 * walk, so they have no source twin by design and the bake sweeps its own.
 *
 * Both callers run the mirror sync first, and that creates the shadow root
 * before anything else, so the walk below always has a directory to read.
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

/**
 * Does the source file backing a shadow entry still exist? A `.cov-map.json`
 * sidecar has no direct twin — it is keyed to its base `.luau`/`.lua`.
 * @param options - Filesystem, source root and shadow-relative path.
 * @returns `true` when the backing source file exists.
 */
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
	// An ignored path is judged on the pattern, not on its twin: its source is
	// still on disk, so the twin check would keep every copy a shadow seeded
	// before the pattern existed. Deciding it here is what lets a warm tree shed
	// them on the run that adds a pattern rather than on the next cold rebuild.
	//
	// A `.cov-map.json` is exempt, for the reason `shouldSyncToShadow` passes
	// over it too: the list governs what gets copied, and a sidecar was never
	// copied — the instrumenter wrote it. Judging it by the list would let a
	// pattern like `**/*.json` delete the sidecar of a module the same run just
	// probed, and the report skips a record whose map is gone, so that module
	// silently vanishes from coverage. Only the twin check applies to it, which
	// is what still clears a sidecar whose module is gone.
	if (
		(isInstrumenterOutput(relativePath) || !isCopyIgnored(relativePath)) &&
		sourceTwinExists({ fileSystem, luauRoot, relativePath })
	) {
		return false;
	}

	// Asked only of what already reads as an orphan, which is the whole of what
	// a bake writes. See {@link BakeOwnershipMatcher}.
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
		// Never descend into these — no other walk in this file does either.
		// Their fate rides on the parent directory's own source, so passing over
		// them here cannot strand an orphaned parent.
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

/**
 * Ownership is the only question an orphaned parent leaves a file.
 * @param options - Filesystem, bake matcher and shadow file path.
 * @returns What the sweep removed.
 */
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

/**
 * Clear an orphaned directory of everything the bake does not own, and go with
 * it once nothing is left — so a spared file keeps its whole chain of parents
 * and nothing else keeps one.
 *
 * The two answers part company on a directory that lost children but kept one:
 * something was removed, so the place still rebuilds, yet the directory stays.
 * @param options - Directory, filesystem and bake matcher.
 * @returns What the sweep removed.
 */
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

/**
 * A directory whose source counterpart is gone takes its whole subtree with it,
 * `node_modules`/dot-dir children included: nothing under an orphaned parent
 * can be anything but orphaned, so there is no judgement to withhold. Leaving
 * such a child behind would strand the stale `foo/` this reconcile exists to
 * clear from beside a fresh `foo.luau`.
 *
 * A bake is the one thing under there that is not stale, and it can be what put
 * the directory there: it writes to a mount the mirror never reached, so the
 * directory it creates has no source twin either. Sweeping the subtree
 * wholesale would take the bake's own file with it and the bake would write
 * both back the same run — the churn {@link BakeOwnershipMatcher} exists to
 * stop. So a run that bakes empties the subtree entry by entry, keeps what the
 * bake owns, and keeps only the directories still holding it.
 * @param options - Walk context plus the child directory paths.
 * @returns `true` when anything was removed.
 */
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
