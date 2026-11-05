const RUNTIME_SUFFIX_PATTERN = /\.(spec|test)\.(ts|luau)$/;

/**
 * Map runtime `.spec`/`.test` include globs to their `-d` type-test globs.
 *
 * @param runtimeInclude - Runtime test include globs.
 * @returns Type-test globs; patterns without a test suffix are dropped.
 */
export function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	return runtimeInclude
		.filter((pattern) => RUNTIME_SUFFIX_PATTERN.test(pattern))
		.map((pattern) => pattern.replace(RUNTIME_SUFFIX_PATTERN, ".$1-d.$2"));
}
