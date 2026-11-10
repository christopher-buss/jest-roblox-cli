import type { GameOutputEntry } from "../protocol/game-output.ts";
import { type ColorFunc, identity, type Styles } from "../terminal/palette.ts";

// Enum.MessageType values as LogService reports them.
const MESSAGE_TYPE_WARNING = 2;
const MESSAGE_TYPE_ERROR = 3;

const LABEL_INDENT = " ".repeat(2);
const LINE_INDENT = " ".repeat(4);

/**
 * Render a package's Game Output block.
 * @param entries - Logged messages in output order.
 * @param styles - Palette to paint labels and lines with.
 * @returns Lines of the block, or none when the package printed nothing.
 */
export function formatGameOutputBlock(
	entries: ReadonlyArray<GameOutputEntry>,
	styles: Styles,
): Array<string> {
	if (entries.length === 0) {
		return [];
	}

	const paints = new Map<number, ColorFunc>([
		[MESSAGE_TYPE_ERROR, styles.status.fail],
		[MESSAGE_TYPE_WARNING, styles.status.pending],
	]);

	const lines = [`${LABEL_INDENT}${styles.dim("Game output:")}`];
	for (const entry of entries) {
		const paint = paints.get(entry.messageType) ?? identity;
		for (const line of entry.message.split("\n")) {
			lines.push(`${LINE_INDENT}${paint(line)}`);
		}
	}

	return lines;
}
