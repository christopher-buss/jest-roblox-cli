import type { TsconfigMapping } from "../types/tsconfig-types.ts";

/** Inputs for {@link findMapping}. */
export interface FindMappingOptions {
	/** Which root to match the path against; defaults to `outDir`. */
	readonly key?: "outDir" | "rootDir";
	/** The path to find a mapping for. */
	readonly filePath: string;
	/** The candidate mappings. */
	readonly mappings: ReadonlyArray<TsconfigMapping>;
}

/** Inputs for {@link replacePrefix}. */
export interface ReplacePrefixOptions {
	/** The path to rewrite. */
	readonly filePath: string;
	/** The directory prefix to remove. */
	readonly from: string;
	/** The directory prefix to put in its place. */
	readonly to: string;
}

/**
 * Find the mapping whose root contains a path, preferring the longest root.
 * @param options - The path, the mappings and which root to match.
 * @returns The best mapping, or `undefined` when none contains the path.
 */
export function findMapping({
	key = "outDir",
	filePath,
	mappings,
}: FindMappingOptions): TsconfigMapping | undefined {
	let best: TsconfigMapping | undefined;
	let bestLength = -1;

	for (const mapping of mappings) {
		const prefix = mapping[key];
		const isMatch = filePath === prefix || filePath.startsWith(`${prefix}/`);

		if (isMatch && prefix.length > bestLength) {
			best = mapping;
			bestLength = prefix.length;
		}
	}

	return best;
}

/**
 * Move a path from one directory prefix to another.
 * @param options - The path and the two prefixes.
 * @returns The rewritten path, or the input when it is not under `from`.
 */
export function replacePrefix({ filePath, from, to }: ReplacePrefixOptions): string {
	if (filePath === from) {
		return to;
	}

	// "." is the implicit root of a `rootDirs` tsconfig: every relative path is
	// under it. The resolver strips the leading "./" from filePaths, so match a
	// bare relative path too — not just an explicit "./" prefix.
	if (from === ".") {
		const rest = filePath.startsWith("./") ? filePath.slice(2) : filePath;
		return `${to}/${rest}`;
	}

	if (filePath.startsWith(`${from}/`)) {
		return `${to}${filePath.slice(from.length)}`;
	}

	return filePath;
}
