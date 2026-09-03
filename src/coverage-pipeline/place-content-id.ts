import { hashString } from "../utils/hash.ts";

/**
 * Every compiled `.luau` a Clean Place holds, as the instrument step recorded
 * it. Structural rather than `Pick<CoverageManifest, …>`, so the id is over
 * exactly what it reads and a caller holding the records some other way is not
 * made to build a manifest around them.
 */
export interface PlaceCoveringSet {
	/** The probed files, by package-relative POSIX path. */
	files: HashedFiles;
	/** Everything else the shadow tree copied, by the same key. */
	nonInstrumentedFiles: HashedFiles;
}

/** Compiled `.luau` files, reduced to the only field the id is taken over. */
type HashedFiles = Record<string, { sourceHash: string }>;

/**
 * What a place's compiled sources hash to — the identity a Clean Place carries
 * so a consumer can prove the place it booted holds the build the run read off
 * disk, rather than trusting a version number the publish minted.
 *
 * The covering set is everything the instrument step recorded, probed and
 * unprobed both. The probed half is the compiled `.luau` ADR-0001 argues is
 * the ground truth for what runs in Roblox, and it is what a mutation splices
 * into. The unprobed half is what the shadow mirror copied beside it — specs,
 * snapshots, `.meta.json`, and any prod file the coverage universe excluded.
 *
 * Both, because the Clean Place holds both, and the unprobed half decides
 * verdicts as directly as the probed one: two builds agreeing on the sources
 * and differing on the specs would score one build's mutants with another
 * build's tests, and a `.meta.json` edit changes instance properties in the
 * built place.
 *
 * The unprobed half is whatever the mirror copied, so it can hold files rojo
 * never mounts — a `.d.ts`, when `coverageCopyIgnorePatterns` is cleared.
 * Editing one moves the id without moving the place. That is over-strict, not
 * unsound: it can only refuse a place, never accept a wrong one, and refusing
 * costs a task where accepting costs a verdict.
 *
 * Two builds that agree here run the same Luau, which includes two checkouts
 * of one commit: their places are byte-identical but their publishes mint
 * different versions. What the id does not cover is what the place build put
 * around that Luau — the synthesized rojo project, its stub mounts, the rojo
 * version — so it answers "the same sources" and not "the same `.rbxl`". That
 * is the ADR-0001 boundary, and it is where a mutation verdict is decided.
 *
 * A place holding no compiled `.luau` at all digests to a constant, and any
 * two such places match. Nothing runs Jest in one, so nothing reaches the
 * guard to be fooled by it.
 *
 * Records are sorted, because the maps' own key order is the order the
 * instrumenter happened to walk in and says nothing about content. Sorting the
 * joined lines orders them by kind and then by path, because NUL is below every
 * character a path can carry. Parts are NUL-joined: a package-relative POSIX
 * path and a hex digest both carry no NUL, and neither is ever empty, so the
 * join is injective. The kind prefix keeps a probed record from aliasing an
 * unprobed one at the same path.
 *
 * @param covering - The instrument step's record of what the place holds.
 * @returns The 64-character hex Place Content Id.
 */
export function computePlaceContentId({ files, nonInstrumentedFiles }: PlaceCoveringSet): string {
	const lines = [...digestLines("f", files), ...digestLines("n", nonInstrumentedFiles)];
	return hashString(lines.sort().join("\0"));
}

function digestLines(kind: string, records: HashedFiles): Array<string> {
	return Object.entries(records).map(([key, record]) => `${kind}\0${key}\0${record.sourceHash}`);
}
