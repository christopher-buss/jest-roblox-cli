const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;
const TS_SOURCE_EXTENSION = /\.tsx?$/;

/**
 * Whether a path names a TypeScript source rather than a hand-authored Luau
 * one. The two compile differently — only a TS source goes through roblox-ts —
 * so this decides whether a roblox-ts rule (the `index` → `init` rename) may be
 * applied to a given path.
 * @param filePath - The path to check.
 * @returns True for a `.ts` or `.tsx` path.
 */
export function isTsSource(filePath: string): boolean {
	return TS_SOURCE_EXTENSION.test(filePath);
}

/**
 * Strip a trailing `.ts`, `.tsx`, `.lua` or `.luau` extension.
 * @param pattern - A path or glob.
 * @returns The input without its source extension.
 */
export function stripTsExtension(pattern: string): string {
	return pattern.replace(TS_OR_LUAU_EXTENSION, "");
}
