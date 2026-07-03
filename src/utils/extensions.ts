const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;

export function stripTsExtension(pattern: string): string {
	return pattern.replace(TS_OR_LUAU_EXTENSION, "");
}
