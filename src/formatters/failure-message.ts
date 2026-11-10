import assert from "node:assert";

const SNAPSHOT_HEADER = /^- Snapshot\s+- \d+/;
const EXPECTED_VALUE = /Expected\b.*?:\s*(.+)/;
const RECEIVED_VALUE = /Received\b.*?:\s*(.+)/;
const ROBLOX_PATH_CHAIN = /^(?:[A-Za-z][\w.@-]*:\d+:\s*)+/;

const EXEC_ERROR_HINTS: Array<[pattern: RegExp, hint: string]> = [
	[
		/loadstring\(\) is not available/,
		'loadstring() must be enabled for Jest to run. Add to your project.json:\n\n  "ServerScriptService": {\n    "$properties": {\n      "LoadStringEnabled": true\n    }\n  }',
	],
];

/**
 * A failure message split into its first line and any diff.
 */
export interface ParsedError {
	/**
	 * Expected value of an expected/received pair.
	 */
	expected?: string | undefined;
	/**
	 * First line of the message.
	 */
	message: string;
	/**
	 * Received value of an expected/received pair.
	 */
	received?: string | undefined;
	/**
	 * Snapshot diff lines.
	 */
	snapshotDiff?: string | undefined;
}

/**
 * Find a setup hint for a known suite-level error.
 * @param message - Cleaned exec error message.
 * @returns The hint, or undefined when no known pattern matches.
 */
export function getExecErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of EXEC_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}

/**
 * Split a failure message into its first line and any diff.
 * @param message - Raw failure message.
 * @returns The parsed parts; diff fields are absent when not found.
 */
export function parseErrorMessage(message: string): ParsedError {
	const lines = message.split("\n");
	const firstLine = lines[0];
	assert(firstLine !== undefined);

	const snapshotHeaderIndex = lines.findIndex((line) => SNAPSHOT_HEADER.test(line));
	if (snapshotHeaderIndex !== -1) {
		const diffLines: Array<string> = [];
		for (let index = snapshotHeaderIndex; index < lines.length; index++) {
			// oxlint-disable-next-line typescript/no-non-null-assertion -- Loop condition
			const line = lines[index]!;
			if (line.startsWith("[string ")) {
				break;
			}

			diffLines.push(line);
		}

		return {
			message: firstLine,
			snapshotDiff: diffLines.join("\n").trimEnd(),
		};
	}

	const expectedMatch = message.match(EXPECTED_VALUE);
	const receivedMatch = message.match(RECEIVED_VALUE);
	return {
		expected: expectedMatch?.[1],
		message: firstLine,
		received: receivedMatch?.[1],
	};
}

/**
 * Extract the error line from a Jest suite `failureMessage`.
 * @param raw - Jest `failureMessage` of a file whose suite threw.
 * @returns The first content line without path prefixes, else the input.
 */
export function cleanExecErrorMessage(raw: string): string {
	const lines = raw.split("\n");

	let contentLine: string | undefined;
	let isPastHeader = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("●")) {
			isPastHeader = true;
			continue;
		}

		if (isPastHeader && trimmed !== "") {
			contentLine = trimmed;
			break;
		}
	}

	if (contentLine === undefined) {
		return raw.trim();
	}

	return contentLine.replace(ROBLOX_PATH_CHAIN, "");
}
