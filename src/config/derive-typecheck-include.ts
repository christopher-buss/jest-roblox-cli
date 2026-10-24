const RUNTIME_SUFFIX_PATTERN = /\.(spec|test)\.(ts|luau)$/;

export function deriveTypecheckInclude(runtimeInclude: ReadonlyArray<string>): Array<string> {
	return runtimeInclude
		.filter((pattern) => RUNTIME_SUFFIX_PATTERN.test(pattern))
		.map((pattern) => pattern.replace(RUNTIME_SUFFIX_PATTERN, ".$1-d.$2"));
}
