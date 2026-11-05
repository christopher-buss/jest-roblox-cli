/**
 * First brace-balanced block of lines in the output that parses as JSON.
 *
 * @param output - Raw runner output.
 * @returns The trimmed JSON text, or `undefined` when no block parses.
 */
export function extractJsonFromOutput(output: string): string | undefined {
	const lines = output.split("\n");
	let braceCount = 0;
	let jsonLines: Array<string> | undefined;

	for (const line of lines) {
		if (jsonLines === undefined) {
			if (!line.trimStart().startsWith("{")) {
				continue;
			}

			braceCount = 0;
			jsonLines = [];
		}

		jsonLines.push(line);
		braceCount += countBraces(line);

		if (braceCount > 0) {
			continue;
		}

		const candidate = jsonLines.join("\n").trim();
		if (isValidJson(candidate)) {
			return candidate;
		}

		jsonLines = undefined;
	}

	return undefined;
}

/**
 * The whole output when it is JSON, else the first JSON block inside it.
 *
 * @param output - Raw runner output.
 * @returns Valid JSON text, or `undefined` when none is found.
 */
export function findJestJsonCandidate(output: string): string | undefined {
	const trimmed = output.trim();
	if (trimmed.startsWith("{") && isValidJson(trimmed)) {
		return trimmed;
	}

	return extractJsonFromOutput(output);
}

function countBraces(line: string): number {
	let count = 0;
	for (const character of line) {
		if (character === "{") {
			count++;
		} else if (character === "}") {
			count--;
		}
	}

	return count;
}

function isValidJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
