import * as path from "node:path";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { MappedCoverageResult } from "./mapper-types.ts";

/**
 * Decides whether a single coverage-universe source file is shown in the agent
 * **text table**. Receives a normalized-absolute source path (see
 * {@link narrowMappedForAgentTable}). This is a display-only narrowing layered
 * on top of `filterCoverageUniverse`: thresholds, the totals line, and the
 * lcov/html/json artifacts always keep the full universe.
 */
export type CoverageDisplayPredicate = (normalizedAbsolutePath: string) => boolean;

// Strips a `.test`/`.spec` (optionally `-d` for type tests) marker while keeping
// the source extension, e.g. `foo.test.ts` → `foo.ts`, `foo.spec.tsx` →
// `foo.tsx`, `foo.test-d.ts` → `foo.ts`, `foo.test.luau` → `foo.luau`.
const TEST_MARKER = /\.(?:test|spec)(?:-d)?(\.[^./]+)$/;

/**
 * Build a predicate that keeps a universe file when it is the **source twin**
 * of one of `testFiles` — the file under test reached by stripping the
 * `.test`/`.spec` marker and keeping the same directory. Membership is exact
 * (not glob), so source paths carrying glob metacharacters (route-group
 * directories like `(foo)`) compare literally. Each test file is resolved
 * against `rootDirectory` and normalized so positionals (absolute) and
 * glob-discovered files (relative) land in the same namespace as the resolved
 * universe keys.
 * @param testFiles - Test file paths, absolute or relative to `rootDirectory`.
 * @param rootDirectory - Base for resolving relative test paths.
 * @returns A predicate over normalized-absolute source paths.
 */
export function sourceTwinFilter(
	testFiles: ReadonlyArray<string>,
	rootDirectory: string,
): CoverageDisplayPredicate {
	const twins = new Set(
		testFiles.map((file) => {
			const absolute = normalizeWindowsPath(path.resolve(rootDirectory, file));
			return absolute.replace(TEST_MARKER, "$1");
		}),
	);

	return (candidate) => twins.has(candidate);
}

/**
 * Build a predicate that keeps a universe file living under one of `roots` —
 * the static include roots of the selected `--project`(s). Containment is a
 * path prefix at a directory boundary (so root `src/shared` matches
 * `src/shared/x.ts` but not `src/shared-extra/x.ts`). Roots are normalized to
 * the same absolute namespace as the resolved universe keys.
 * @param roots - Static include roots of the selected projects.
 * @returns A predicate over normalized-absolute source paths.
 */
export function projectRootFilter(roots: ReadonlyArray<string>): CoverageDisplayPredicate {
	const normalizedRoots = roots.map((root) => normalizeWindowsPath(root));

	return (candidate) => {
		return normalizedRoots.some(
			(root) => candidate === root || candidate.startsWith(`${root}/`),
		);
	};
}

/**
 * Narrow a mapped coverage universe to the files `predicate` keeps. Each key
 * is resolved to a normalized-absolute path before the predicate runs,
 * mirroring how `filterCoverageUniverse` canonicalizes paths so the two layers
 * agree. Used only for the agent text table; every other reporter and the
 * totals line keep the full universe.
 * @param mapped - Mapped coverage of the full universe.
 * @param predicate - Decides which files the table shows.
 * @returns A new result holding only the kept files.
 */
export function narrowMappedForAgentTable(
	mapped: MappedCoverageResult,
	predicate: CoverageDisplayPredicate,
): MappedCoverageResult {
	const files = Object.fromEntries(
		Object.entries(mapped.files).filter(([filePath]) => {
			return predicate(normalizeWindowsPath(path.resolve(filePath)));
		}),
	);

	return { files };
}
