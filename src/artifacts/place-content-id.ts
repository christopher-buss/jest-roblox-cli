import { hashString } from "../utils/hash.ts";

/** Every compiled `.luau` a Clean Place holds. */
export interface PlaceCoveringSet {
	/** The probed files, by package-relative POSIX path. */
	files: HashedFiles;
	/** Everything else the shadow tree copied, by the same key. */
	nonInstrumentedFiles: HashedFiles;
}

type HashedFiles = Record<string, { sourceHash: string }>;

/**
 * Hash of the compiled sources a Clean Place holds.
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
