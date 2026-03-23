export function stripTsExtension(pattern: string): string {
	return pattern.replace(/\.(tsx?|luau?)$/, "");
}
