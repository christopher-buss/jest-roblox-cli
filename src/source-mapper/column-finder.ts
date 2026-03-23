/**
 * Finds the column position of the failing matcher in an expect() call. Returns
 * 1-indexed column position, or undefined if no expect is found.
 */
export function findExpectationColumn(lineText: string): number | undefined {
	if (!lineText) {
		return undefined;
	}

	// Match expect(...) or expect.method(...) (e.g. expect.assertions)
	const expectIndex = lineText.search(/\bexpect\s*[.(]/);
	if (expectIndex === -1) {
		return undefined;
	}

	const afterExpect = lineText.slice(expectIndex);
	const matcherRegex = /[.:]\s*([A-Za-z_$][\w$]*)\s*(?=\()/g;
	let lastMatcher: null | RegExpExecArray = null;

	for (const match of afterExpect.matchAll(matcherRegex)) {
		lastMatcher = match;
	}

	const matcherName = lastMatcher?.[1];
	if (lastMatcher === null || matcherName === undefined) {
		return undefined;
	}

	const matcherNameOffset = lastMatcher.index + lastMatcher[0].indexOf(matcherName);
	return expectIndex + matcherNameOffset + 1;
}
