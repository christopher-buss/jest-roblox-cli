const BLOCK_COMMENT_OPEN = /^--(\[=*\[)/;
const CARRIAGE_RETURN = "\r";
const COMMENT_OPEN = "--";
const DIRECTIVE_OPEN = "--!";
const WHITESPACE = /\s/;

/** What one line of the opening comment run left behind for the next. */
interface HeaderLineScan {
	/** The `]==]` an unfinished block comment on this line is waiting for. */
	closer: string | undefined;
	/** True when a token appeared, which closes the run for the whole file. */
	hasEnded: boolean;
	/**
	 * True when a `--!` comment Luau still reads as a directive stands here.
	 */
	isDirective: boolean;
}

/** One step along a line: what it left behind, and how far it reached. */
interface HeaderAdvance {
	state: HeaderLineScan;
	/** Columns the step covers, or undefined when the line is done with. */
	width: number | undefined;
}

/** What the text at one column is, read from outside any comment. */
interface CodeStep {
	closer: string | undefined;
	hasEnded: boolean;
	isDirective: boolean;
	width: number | undefined;
}

/**
 * How many lines a caller must leave above code it injects into a Luau file,
 * so that every directive the file opens with keeps its meaning.
 *
 * Luau reads `--!strict`, `--!native` and the rest for as long as no token has
 * opened the file, and it lexes blank lines, ordinary comments and indentation
 * away rather than counting them as a token. So the run reaches to the last
 * `--!` line ahead of the first token, however the lines in between look, and
 * injected code goes behind that line — put it above and Luau stops reading
 * every directive it displaces.
 *
 * Nothing but comments and whitespace can stand there, which is what makes
 * reading them without the parser sound: no literal can precede a file's first
 * token, so there is no string to mistake a `--` inside for a comment.
 *
 * Counted in the lines the caller holds, which are split on `\n`. A bare `\r`
 * ends a comment for Luau without opening a line, so one of those lines can
 * carry a directive and then code; the count stops short of such a line rather
 * than name a place to inject that would land above the code.
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

/**
 * What the text at one column is, read from outside any comment: whitespace
 * passes, a token closes the run, a block comment hands back its closer, and a
 * `--` comment ends on a bare `\r` as readily as on the line — the lexer reads
 * on from there without counting a line.
 */
function stepFromCode(rest: string): CodeStep {
	if (WHITESPACE.test(rest.charAt(0))) {
		return { closer: undefined, hasEnded: false, isDirective: false, width: 1 };
	}

	if (!rest.startsWith(COMMENT_OPEN)) {
		return { closer: undefined, hasEnded: true, isDirective: false, width: undefined };
	}

	// `[==[` closes on `]==]` alone, so the level rides along in the closer.
	const [, bracket] = BLOCK_COMMENT_OPEN.exec(rest) ?? [];
	if (bracket !== undefined) {
		const closer = bracket.replaceAll("[", "]");
		const width = COMMENT_OPEN.length + bracket.length;
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

/**
 * Take one step along a line, either hunting the closer an open block comment
 * is waiting for or reading fresh text.
 *
 * A token ends the run and takes any directive that shares its line down with
 * it: the count is in whole lines, so a caller cannot lift such a directive
 * away without carrying the code up too.
 */
function advanceOnce(line: string, column: number, state: HeaderLineScan): HeaderAdvance {
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

/**
 * Read one line as far as the opening comment run goes, carrying in whatever
 * closer an earlier line's block comment is still waiting for.
 */
function scanHeaderLine(line: string, openCloser: string | undefined): HeaderLineScan {
	let state: HeaderLineScan = { closer: openCloser, hasEnded: false, isDirective: false };
	let column = 0;

	while (column < line.length) {
		const { state: nextState, width } = advanceOnce(line, column, state);
		state = nextState;
		if (width === undefined) {
			return state;
		}

		column += width;
	}

	return state;
}
