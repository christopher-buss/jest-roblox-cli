const BLOCK_COMMENT_OPEN = /^--\[=*\[/;
const CARRIAGE_RETURN = "\r";
const COMMENT_OPEN = "--";
const DIRECTIVE_OPEN = "--!";
const WHITESPACE = /\s/;

interface HeaderLineScan {
	closer: string | undefined;
	hasEnded: boolean;
	isDirective: boolean;
}

interface HeaderAdvance {
	state: HeaderLineScan;
	width: number | undefined;
}

type CodeStep =
	| {
			closer: string | undefined;
			hasEnded: false;
			isDirective: boolean;
			width: number | undefined;
	  }
	| { hasEnded: true };

/**
 * Count the leading lines injected code must stay below, so every `--!`
 * directive the file opens with keeps its meaning.
 * @param lines - The file's lines, split on `\n`.
 * @returns The number of leading lines injected code must stay below.
 */
export function countLinesThroughLastDirective(lines: ReadonlyArray<string>): number {
	let closer: string | undefined;
	let throughLine = 0;

	for (const [lineIndex, line] of lines.entries()) {
		const { closer: nextCloser, hasEnded, isDirective } = scanHeaderLine(line, closer);
		if (isDirective) {
			throughLine = lineIndex + 1;
		}

		if (hasEnded) {
			break;
		}

		closer = nextCloser;
	}

	return throughLine;
}

function stepFromCode(rest: string): CodeStep {
	if (WHITESPACE.test(rest.charAt(0))) {
		return { closer: undefined, hasEnded: false, isDirective: false, width: 1 };
	}

	if (!rest.startsWith(COMMENT_OPEN)) {
		return { hasEnded: true };
	}

	const opener = BLOCK_COMMENT_OPEN.exec(rest)?.[0];
	if (opener !== undefined) {
		const closer = opener.slice(COMMENT_OPEN.length).replaceAll("[", "]");
		const width = opener.length;
		return { closer, hasEnded: false, isDirective: false, width };
	}

	const returnAt = rest.indexOf(CARRIAGE_RETURN);
	return {
		closer: undefined,
		hasEnded: false,
		isDirective: rest.startsWith(DIRECTIVE_OPEN),
		width: returnAt === -1 ? undefined : returnAt + 1,
	};
}

function advanceOnce({
	column,
	line,
	state,
}: {
	readonly column: number;
	readonly line: string;
	readonly state: HeaderLineScan;
}): HeaderAdvance {
	const { closer, isDirective } = state;
	if (closer !== undefined) {
		const closeAt = line.indexOf(closer, column);
		return closeAt === -1
			? { state, width: undefined }
			: {
					state: { closer: undefined, hasEnded: false, isDirective },
					width: closeAt + closer.length - column,
				};
	}

	const step = stepFromCode(line.slice(column));
	if (step.hasEnded) {
		return {
			state: { closer: undefined, hasEnded: true, isDirective: false },
			width: undefined,
		};
	}

	return {
		state: {
			closer: step.closer,
			hasEnded: false,
			isDirective: isDirective || step.isDirective,
		},
		width: step.width,
	};
}

function scanHeaderLine(line: string, openCloser: string | undefined): HeaderLineScan {
	let state: HeaderLineScan = { closer: openCloser, hasEnded: false, isDirective: false };
	let column = 0;

	while (column < line.length) {
		const { state: nextState, width } = advanceOnce({ column, line, state });
		state = nextState;
		if (width === undefined) {
			return state;
		}

		column += width;
	}

	return state;
}
