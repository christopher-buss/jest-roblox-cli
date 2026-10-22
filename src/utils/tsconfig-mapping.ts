import type { TsconfigMapping } from "../types/tsconfig.ts";

export interface FindMappingOptions {
	readonly key?: "outDir" | "rootDir";
	readonly filePath: string;
	readonly mappings: ReadonlyArray<TsconfigMapping>;
}

export interface ReplacePrefixOptions {
	readonly filePath: string;
	readonly from: string;
	readonly to: string;
}

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
