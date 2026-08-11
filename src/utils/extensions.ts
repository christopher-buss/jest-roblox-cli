const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;
const TS_SOURCE_EXTENSION = /\.tsx?$/;

/**
 * Whether a path names a TypeScript source rather than a hand-authored Luau
 * one. The two compile differently — only a TS source goes through roblox-ts —
 * so this decides whether a roblox-ts rule (the `index` → `init` rename) may be
 * applied to a given path.
 */
export function isTsSource(filePath: string): boolean {
	return TS_SOURCE_EXTENSION.test(filePath);
}

export function stripTsExtension(pattern: string): string {
	return pattern.replace(TS_OR_LUAU_EXTENSION, "");
}
