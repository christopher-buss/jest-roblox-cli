import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";
import process from "node:process";

import type { FileSystem } from "../../src/utils/file-system.ts";

/** The `memfs` volume API a spec seeds through and asserts against. */
export type MemoryVolume = ReturnType<typeof memfs>["vol"];

export interface MemoryFileSystem {
	/** The seam to hand the code under test. */
	readonly fileSystem: FileSystem;
	/** The volume behind it, for seeding and for reading back what landed. */
	readonly volume: MemoryVolume;
}

/**
 * A filesystem of its own for one test. Nothing is shared with another test or
 * another spec file, so there is no reset to forget and no ordering between
 * files that can change what a test sees.
 *
 * @param seed - Files to create up front, in `vol.fromJSON` shape.
 * @param cwd - What a relative key in `seed` is anchored to. Defaults to
 *   `process.cwd()`, because that is what memfs resolves a relative *read*
 *   against no matter how the volume was seeded — anchor the two differently
 *   and the volume answers `false` to a path it was handed verbatim.
 *
 *   Windows hides a mismatch here: memfs strips the drive from `C:/foo`, so a
 *   fixture written that way is absolute there and relative everywhere else.
 */
export function createMemoryFileSystem(
	seed?: Record<string, string>,
	cwd: string = process.cwd(),
): MemoryFileSystem {
	const { fs, vol } = memfs(seed, cwd);
	// `memfs` implements the whole sync API and the promise methods this CLI
	// awaits, but it types them a Node release behind: `promises.mkdir` rejects
	// `mode?: undefined` under `exactOptionalPropertyTypes`, and
	// `promises.mkdtempDisposable` has no declaration at all. Neither gap is a
	// behaviour gap, and narrowing `FileSystem` to dodge them would weaken the
	// type production is checked against, so the bridge lands here instead.
	return { fileSystem: fromAny(fs), volume: vol };
}
