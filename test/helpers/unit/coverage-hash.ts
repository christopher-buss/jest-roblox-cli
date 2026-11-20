import { hashString } from "#src/utils/hash.ts";

export { hashBuffer, hashFile, hashString } from "#src/utils/hash.ts";

export function copyIgnoreHash(patterns: ReadonlyArray<string>): string {
	return hashString(JSON.stringify([...patterns].toSorted()));
}
