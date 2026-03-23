import type { TsconfigMapping } from "../types/tsconfig.ts";

export function findMapping(
	filePath: string,
	mappings: ReadonlyArray<TsconfigMapping>,
	key: "outDir" | "rootDir" = "outDir",
): TsconfigMapping | undefined {
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

export function replacePrefix(filePath: string, from: string, to: string): string {
	if (filePath === from) {
		return to;
	}

	if (filePath.startsWith(`${from}/`)) {
		return `${to}${filePath.slice(from.length)}`;
	}

	return filePath;
}
