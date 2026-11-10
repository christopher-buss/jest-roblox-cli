import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { isWithinRoot } from "../utils/normalize-windows-path.ts";

/** An absolute directory whose `$path` mounts read from another directory. */
export interface PathRedirect {
	/** The directory a mount names. */
	from: PosixRoot;
	/** The directory the place reads in its stead. */
	to: string;
}

/**
 * The path `target` reads from once the first redirect containing it applies.
 * @param target - Normalized absolute path a `$path` mount names.
 * @param redirects - Redirects in priority order.
 * @returns The redirected path, or `undefined` when no redirect contains it.
 */
export function redirectPath(
	target: string,
	redirects: ReadonlyArray<PathRedirect>,
): string | undefined {
	for (const redirect of redirects) {
		if (isWithinRoot(target, redirect.from)) {
			return redirect.to + target.slice(redirect.from.length);
		}
	}

	return undefined;
}
