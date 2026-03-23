import type { ParsedStack } from "./types.ts";

const FRAME_REGEX = /\[string "([^"]+)"\]:(\d+)(?::(\d+))?/g;

export function parseStack(input: string): ParsedStack {
	const frames: ParsedStack["frames"] = [];
	let firstMatchIndex = input.length;

	for (const match of input.matchAll(FRAME_REGEX)) {
		if (match.index < firstMatchIndex) {
			firstMatchIndex = match.index;
		}

		frames.push({
			column: match[3] !== undefined ? Number(match[3]) : undefined,
			dataModelPath: String(match[1]),
			line: Number(match[2]),
		});
	}

	const message = input.slice(0, firstMatchIndex).trim();

	return { frames, message };
}
