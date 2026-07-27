import type { RawErrorsMap, TscErrorInfo } from "./types.ts";

const errorCodeRegExp = /error TS(?<errorCode>\d+)/;
const LINE_SPLIT = /\r?\n/;

interface TscPosition {
	column: number;
	line: number;
}

interface TscErrorDetail {
	errorCode: number;
	errorMessage: string;
}

export function parseTscOutput(stdout: string): RawErrorsMap {
	const map: RawErrorsMap = new Map();

	const merged = stdout.split(LINE_SPLIT).reduce<Array<string>>((lines, next) => {
		if (!next) {
			return lines;
		}

		if (next[0] !== " ") {
			lines.push(next);
		} else if (lines.length > 0) {
			lines[lines.length - 1] += `\n${next}`;
		}

		return lines;
	}, []);

	for (const line of merged) {
		const [filePath, info] = parseTscErrorLine(line);
		if (!info) {
			continue;
		}

		const existing = map.get(filePath);
		if (existing) {
			existing.push(info);
		} else {
			map.set(filePath, [info]);
		}
	}

	return map;
}

// The `(line,column)` prefix of the tail. Undefined when either part is
// missing, which makes the whole line a non-diagnostic.
function parsePosition(rest: string, closeParenIndex: number): TscPosition | undefined {
	const position = rest.slice(1, closeParenIndex);
	const [lineString, columnString] = position.split(",", 2);
	if (
		lineString === undefined ||
		lineString === "" ||
		columnString === undefined ||
		columnString === ""
	) {
		return undefined;
	}

	return { column: Number(columnString), line: Number(lineString) };
}

// Everything after `(line,column)`: `: error TS<code>: <message>`. Undefined
// when the tail carries no error code.
function parseTscErrorDetail(afterParen: string): TscErrorDetail | undefined {
	const match = errorCodeRegExp.exec(afterParen);
	const errorCodeString = match?.groups?.["errorCode"];
	if (errorCodeString === undefined) {
		return undefined;
	}

	const errorCode = Number(errorCodeString);
	const marker = `error TS${String(errorCode)}: `;
	const markerIndex = afterParen.indexOf(marker);
	return { errorCode, errorMessage: afterParen.slice(markerIndex + marker.length).trim() };
}

function parseTscErrorLine(line: string): [string, null | TscErrorInfo] {
	const parenIndex = line.lastIndexOf("(", line.indexOf("): error TS"));
	if (parenIndex === -1) {
		return ["", null];
	}

	const filePath = line.slice(0, parenIndex);
	const rest = line.slice(parenIndex);

	// closeParenIndex is guaranteed to exist because parenIndex was found via
	// lastIndexOf("(", indexOf("): error TS")), which requires ")" to be present.
	const closeParenIndex = rest.indexOf(")");
	const position = parsePosition(rest, closeParenIndex);
	if (position === undefined) {
		return [filePath, null];
	}

	const detail = parseTscErrorDetail(rest.slice(closeParenIndex + 1));
	if (detail === undefined) {
		return [filePath, null];
	}

	return [
		filePath,
		{
			column: position.column,
			errorCode: detail.errorCode,
			errorMessage: detail.errorMessage,
			filePath,
			line: position.line,
		},
	];
}
