import type { ResolvedProjectConfig } from "../config/projects.ts";
import { extractStaticRoot } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/schema.ts";

const SPEC_OR_TEST_EXTENSION = /\.(?:spec|test)(\.\w+)$/;

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
	const rootsByExtension = collectRootsByExtension(projects);
	if (rootsByExtension.size === 0) {
		return undefined;
	}

	return buildCoveragePatterns(rootsByExtension);
}

/**
 * The include globs this run's coverage universe is actually made of: the
 * user's `collectCoverageFrom` when set, otherwise the set derived from the
 * projects' own `include`.
 *
 * The single authority for that `??`. Instrumentation asks it before the run
 * (to decide what earns probes) and the report asks it after (to decide what
 * to render); resolving the fallback in only one of the two would probe files
 * the report drops, or — worse — drop files the report expects.
 */
export function resolveCoverageInclude(
	config: Pick<ResolvedConfig, "collectCoverage" | "collectCoverageFrom">,
	projects: ReadonlyArray<Pick<ResolvedProjectConfig, "include">>,
): Array<string> | undefined {
	if (!config.collectCoverage) {
		return config.collectCoverageFrom;
	}

	return config.collectCoverageFrom ?? deriveCoverageFromIncludes(projects);
}

/**
 * Infers the source file extension from an include pattern by stripping the
 * `.spec` or `.test` suffix. Throws when the pattern has no recognizable test
 * extension so that misconfigured globs fail loudly.
 */
function inferSourceExtension(pattern: string): string {
	const match = pattern.match(SPEC_OR_TEST_EXTENSION);
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

/**
 * Groups the static root of every include pattern by the source extension that
 * pattern implies. A pattern with no static root is skipped.
 */
function collectRootsByExtension(
	projects: ReadonlyArray<Pick<ResolvedProjectConfig, "include">>,
): Map<string, Set<string>> {
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

	return rootsByExtension;
}

function buildCoveragePatterns(rootsByExtension: Map<string, Set<string>>): Array<string> {
	const patterns: Array<string> = [];

	for (const [extension, roots] of rootsByExtension) {
		for (const root of roots) {
			patterns.push(`${root}/**/*${extension}`);
		}
	}

	// `.client`/`.server` compile to LocalScript/Script (not ModuleScript), so
	// nothing can `require` them — they are unreachable from any test and can
	// never be covered. Excluding them keeps untestable boot entry points out of
	// the coverage universe, mirroring the `.spec`/`.test` exclusion.
	for (const extension of rootsByExtension.keys()) {
		patterns.push(
			`!**/*.spec${extension}`,
			`!**/*.test${extension}`,
			`!**/*.client${extension}`,
			`!**/*.server${extension}`,
		);
	}

	return patterns;
}
