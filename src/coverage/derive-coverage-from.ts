import type { ResolvedProjectConfig } from "../config/projects.ts";
import { extractStaticRoot } from "../config/projects.ts";

/**
 * Derives `collectCoverageFrom` glob patterns from project `include` patterns.
 *
 * Extracts the static root directory from each include pattern and generates
 * coverage globs that match all `.ts` source files within those roots, excluding
 * test files. Returns `undefined` when no roots can be extracted (preserving
 * default all-files behavior).
 */
export function deriveCoverageFromIncludes(
	projects: ReadonlyArray<Pick<ResolvedProjectConfig, "include">>,
): Array<string> | undefined {
	const roots = new Set<string>();

	for (const project of projects) {
		for (const pattern of project.include) {
			try {
				const { root } = extractStaticRoot(pattern);
				roots.add(root);
			} catch {
				// Pattern without static root — skip
			}
		}
	}

	if (roots.size === 0) {
		return undefined;
	}

	const patterns: Array<string> = [];
	for (const root of roots) {
		patterns.push(`${root}/**/*.ts`);
	}

	// Exclude test files from coverage
	patterns.push("!**/*.spec.ts", "!**/*.test.ts");

	return patterns;
}
