import type { RawErrorsMap, TscErrorInfo } from "./types.ts";

const LINE_SPLIT = /\r?\n/;
const TSC_ERROR_DETAIL = /^: error TS(?<errorCode>\d+): (?<errorMessage>[\s\S]*)$/;

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
	let previousError: TscErrorInfo | undefined;

	for (const line of stdout.split(LINE_SPLIT)) {
		if (line === "") {
			continue;
		}

		if (line[0] === " ") {
			if (previousError !== undefined) {
				previousError.errorMessage += `\n${line}`;
			}

			continue;
		}

		const info = parseTscErrorLine(line);
		previousError = info;
		if (info === undefined) {
			continue;
		}

		const existing = map.get(info.filePath);
		if (existing) {
			existing.push(info);
		} else {
			map.set(info.filePath, [info]);
		}
	}

	return map;
}

function parsePosition(rest: string, closeParenIndex: number): TscPosition | undefined {
	const position = rest.slice(1, closeParenIndex);
	const [lineString, columnString] = position.split(",", 2);
	if (lineString === "" || columnString === undefined || columnString === "") {
		return undefined;
	}

	return { column: Number(columnString), line: Number(lineString) };
}

function parseTscErrorDetail(afterParen: string): TscErrorDetail | undefined {
	const groups = TSC_ERROR_DETAIL.exec(afterParen)?.groups;
	const errorCodeString = groups?.["errorCode"];
	const errorMessage = groups?.["errorMessage"];
	if (errorCodeString === undefined || errorMessage === undefined) {
		return undefined;
	}

	return { errorCode: Number(errorCodeString), errorMessage: errorMessage.trim() };
}

function parseTscErrorLine(line: string): TscErrorInfo | undefined {
	const parenIndex = line.lastIndexOf("(", line.indexOf("): error TS"));
	if (parenIndex === -1) {
		return undefined;
	}

	const filePath = line.slice(0, parenIndex);
	const rest = line.slice(parenIndex);
	const closeParenIndex = rest.indexOf(")");
	const position = parsePosition(rest, closeParenIndex);
	if (position === undefined) {
		return undefined;
	}

	const detail = parseTscErrorDetail(rest.slice(closeParenIndex + 1));
	if (detail === undefined) {
		return undefined;
	}

	return {
		column: position.column,
		errorCode: detail.errorCode,
		errorMessage: detail.errorMessage,
		filePath,
		line: position.line,
	};
}
