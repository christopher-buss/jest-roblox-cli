import type { RawErrorsMap, TypeTestDiagnostic } from "./types.ts";

const LINE_SPLIT = /\r?\n/;
const LUAU_HEADER =
	/^(?<filePath>.+?):(?<line>\d+):(?<column>\d+)-\d+(?::\d+)?: \(\w+\) (?<code>\w+): (?<message>.*)$/;
const TYPE_FUNCTION_PREFIX = /^'[^']+' type function errored at runtime: \[string "[^"]*"\]:\d+: /;

export function parseLuauOutput(stdout: string): RawErrorsMap {
	const map: RawErrorsMap = new Map();
	let previous: TypeTestDiagnostic | undefined;

	for (const line of stdout.split(LINE_SPLIT)) {
		if (line === "") {
			previous = undefined;
			continue;
		}

		const groups = LUAU_HEADER.exec(line)?.groups;
		if (groups === undefined) {
			if (previous !== undefined) {
				previous.message += `\n${line.trimEnd()}`;
			}

			continue;
		}

		const diagnostic = toDiagnostic(groups);
		previous = diagnostic;
		const existing = map.get(diagnostic.filePath);
		if (existing) {
			existing.push(diagnostic);
		} else {
			map.set(diagnostic.filePath, [diagnostic]);
		}
	}

	return map;
}

function toDiagnostic(groups: Record<string, string | undefined>): TypeTestDiagnostic {
	return {
		code: String(groups["code"]),
		column: Number(groups["column"]),
		filePath: String(groups["filePath"]),
		line: Number(groups["line"]),
		message: String(groups["message"]).replace(TYPE_FUNCTION_PREFIX, "").trimEnd(),
	};
}
