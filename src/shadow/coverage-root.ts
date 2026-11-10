import * as path from "node:path";

import type { PathRedirect } from "../staging/path-redirect.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";

/** One source root and the instrumented shadow tree standing in for it. */
export interface CoverageRoot {
	/** The source root, in the one spelling `toPosixRoot` gives it. */
	luauRoot: PosixRoot;
	/** Path of the shadow directory, absolute or relocated. */
	shadowDir: string;
}

/**
 * Map coverage roots, resolved against the package directory, to redirects.
 * @param packageDirectory - Directory the roots resolve against.
 * @param roots - Roots as the config wrote them.
 * @returns One synthesis redirect per root, in the same order.
 */
export function toPathRedirects(
	packageDirectory: string,
	roots: ReadonlyArray<CoverageRoot>,
): Array<PathRedirect> {
	return roots.map((root) => {
		return {
			from: toPosixRoot(path.resolve(packageDirectory, root.luauRoot)),
			to: normalizeWindowsPath(root.shadowDir),
		};
	});
}
