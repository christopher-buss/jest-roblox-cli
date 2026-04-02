import type { ResolvedProjectConfig } from "../config/projects.ts";
import { extractStaticRoot } from "../config/projects.ts";

/**
 * Derives `collectCoverageFrom` glob patterns from project `include` patterns.
 *
 * Extracts the static root directory from each include pattern and generates
 * coverage globs that match source files within those roots, excluding test
 * files. The source extension (`.ts`, `.tsx`, `.luau`, `.lua`) is inferred from
 * each include pattern. Returns `undefined` when no roots can be extracted
 * (preserving default all-files behavior).
 */
export function deriveCoverageFromIncludes(
	projects: ReadonlyArray<Pick<ResolvedProjectConfig, "include">>,
): Array<string> | undefined {
	const rootsByExtension = new Map<string, Set<string>>();

	for (const project of projects) {
		for (const pattern of project.include) {
			const extension = inferSourceExtension(pattern);
			try {
				const { root } = extractStaticRoot(pattern);
				const roots = rootsByExtension.get(extension) ?? new Set<string>();
				roots.add(root);
				rootsByExtension.set(extension, roots);
			} catch {
				// Pattern without static root — skip
			}
		}
	}

	if (rootsByExtension.size === 0) {
		return undefined;
	}

	const patterns: Array<string> = [];

	for (const [extension, roots] of rootsByExtension) {
		for (const root of roots) {
			patterns.push(`${root}/**/*${extension}`);
		}
	}

	for (const extension of rootsByExtension.keys()) {
		patterns.push(`!**/*.spec${extension}`, `!**/*.test${extension}`);
	}

	return patterns;
}

/**
 * Infers the source file extension from an include pattern by stripping the
 * `.spec` or `.test` suffix. Throws when the pattern has no recognizable test
 * extension so that misconfigured globs fail loudly.
 */
function inferSourceExtension(pattern: string): string {
	const match = pattern.match(/\.(?:spec|test)(\.\w+)$/);
	if (!match) {
		throw new Error(
			`Cannot infer source extension from include pattern "${pattern}". ` +
				"Patterns must end with .spec.<ext> or .test.<ext> (e.g. **/*.spec.ts, **/*.test.luau).",
		);
	}

	const [, extension] = match;
	// eslint-disable-next-line ts/no-non-null-assertion -- capture group 1 always present when match succeeds
	return extension!;
}
