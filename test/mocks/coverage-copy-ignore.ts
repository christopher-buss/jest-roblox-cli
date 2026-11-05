import picomatch from "picomatch";

import type { CopyIgnoreMatcher } from "../../src/coverage-pipeline/discover-files.ts";

export function copyIgnoreMatcher(patterns: ReadonlyArray<string>): CopyIgnoreMatcher {
	return picomatch([...patterns]);
}
