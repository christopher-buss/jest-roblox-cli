import * as fs from "node:fs";

/**
 * The shadow's two entry makers: one for a directory, one for the path a file
 * is about to take. Both answer the same question — what already sits here, and
 * is it the wrong kind of thing?
 *
 * A source path that changed kind between runs leaves the warm shadow holding
 * last run's entry exactly where this run's has to go, in both directions. The
 * reconcile pass is no help either way: it runs after the mirror walk, and it
 * only drops entries whose source is gone — these still have a source, of the
 * other kind now.
 *
 * The type is read rather than inferred from a failed write. Implementations
 * disagree on the clash: a recursive `mkdirSync` onto a file throws under Node
 * and does nothing at all under memfs, so the error is not a signal either
 * writer can act on.
 *
 * Their own module because both writers into the shadow need them, and
 * `shadow-root.ts` cannot hold them for the instrumenter: it already imports
 * `instrumentRoot`, so the export back would close a cycle.
 */

/**
 * Make one shadow directory, clearing a file that occupies its path. Returns
 * whether the shadow gained a directory it did not have — a warm run reads that
 * as "a directory appeared upstream" and rebuilds the place around it.
 *
 * One level only. Callers walk parent-first, so the chain above is already
 * judged by the time this reaches any level of it.
 */
export function createShadowDirectory(shadowPath: string): boolean {
	const existing = fs.statSync(shadowPath, { throwIfNoEntry: false });
	if (existing?.isDirectory() === true) {
		return false;
	}

	if (existing !== undefined) {
		fs.rmSync(shadowPath, { force: true });
	}

	fs.mkdirSync(shadowPath, { recursive: true });
	return true;
}

/**
 * Clear a directory squatting on the path a shadow file has to take. Only a
 * directory can block one: `writeFileSync` replaces a file of any size, and a
 * shadow holds nothing else.
 *
 * The subtree goes with it. Every entry below a directory the source no longer
 * has is orphaned by definition, and leaving one behind would only re-block the
 * path. `force` covers the entry going away between the `stat` and the `rm`.
 */
export function clearDirectoryAtFilePath(shadowPath: string): void {
	if (fs.statSync(shadowPath, { throwIfNoEntry: false })?.isDirectory() === true) {
		fs.rmSync(shadowPath, { force: true, recursive: true });
	}
}

/**
 * Is there a file at this path? The question every carry-forward has to ask
 * before it keeps a record, because a record names a file and `existsSync`
 * answers for an entry of any kind. An interrupted run that changed a source's
 * kind leaves a directory on the path a record still claims, and keeping that
 * record hands rojo a Folder under the name a file should have — silently,
 * because nothing on that path throws.
 */
export function shadowHoldsFile(shadowPath: string): boolean {
	return fs.statSync(shadowPath, { throwIfNoEntry: false })?.isFile() === true;
}
