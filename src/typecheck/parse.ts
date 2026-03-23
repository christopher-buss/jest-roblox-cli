import type { RawErrorsMap, TscErrorInfo } from "./types.ts";

const errorCodeRegExp = /error TS(?<errorCode>\d+)/;

export function parseTscErrorLine(line: string): [string, null | TscErrorInfo] {
	const parenIndex = line.lastIndexOf("(", line.indexOf("): error TS"));
	if (parenIndex === -1) {
		return ["", null];
	}

	const filePath = line.slice(0, parenIndex);
	const rest = line.slice(parenIndex);

	// closeParenIndex is guaranteed to exist because parenIndex was found via
	// lastIndexOf("(", indexOf("): error TS")), which requires ")" to be present.
	const closeParenIndex = rest.indexOf(")");
	const position = rest.slice(1, closeParenIndex);
	const [lineString, columnString] = position.split(",");
	if (
		lineString === undefined ||
		lineString === "" ||
		columnString === undefined ||
		columnString === ""
	) {
		return [filePath, null];
	}

	const afterParen = rest.slice(closeParenIndex + 1);
	const match = errorCodeRegExp.exec(afterParen);
	const errorCodeString = match?.groups?.["errorCode"];
	if (errorCodeString === undefined) {
		return [filePath, null];
	}

	const errorCode = Number(errorCodeString);
	const marker = `error TS${String(errorCode)}: `;
	const markerIndex = afterParen.indexOf(marker);
	const errorMessage = afterParen.slice(markerIndex + marker.length).trim();

	return [
		filePath,
		{
			column: Number(columnString),
			errorCode,
			errorMessage,
			filePath,
			line: Number(lineString),
		},
	];
}

export function parseTscOutput(stdout: string): RawErrorsMap {
	const map: RawErrorsMap = new Map();

	const merged = stdout.split(/\r?\n/).reduce<Array<string>>((lines, next) => {
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
