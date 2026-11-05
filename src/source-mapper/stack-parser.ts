import type { ParsedStack } from "./source-mapper-types.ts";

const FRAME_REGEX = /\[string "([^"]+)"\]:(\d+)(?::(\d+))?/g;

/**
 * Split a failure message into its text and `[string "..."]` frames.
 * @param input - The failure message.
 * @returns The text before the first frame and every frame.
 */
export function parseStack(input: string): ParsedStack {
	const frames: ParsedStack["frames"] = [];
	let firstMatchIndex = input.length;

	for (const match of input.matchAll(FRAME_REGEX)) {
		if (frames.length === 0) {
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
