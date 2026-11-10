const EXPECT_CALL = /\bexpect\s*[.(]/;

/**
 * Find the column of the failing matcher in an expect() call.
 * @param lineText - The source line of the failure.
 * @returns The 1-indexed matcher column, or `undefined`.
 */
export function findExpectationColumn(lineText: string | undefined): number | undefined {
	if (lineText === undefined) {
		return undefined;
	}

	const expectIndex = EXPECT_CALL.exec(lineText)?.index;
	if (expectIndex === undefined) {
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
