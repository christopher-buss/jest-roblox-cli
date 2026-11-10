import type { StreamingResultEntry } from "../protocol/streaming-summary.ts";
import type { ColorFunc, Styles } from "../terminal/palette.ts";
import { composeEntryDisplayName } from "../utils/display-name.ts";

interface PushPartOptions {
	colorize: ColorFunc;
	count: number;
	label: string;
	parts: Array<string>;
}

/**
 * Build a single-line per-package status string for the streaming
 * progress sink. Format: `▶ <pkg> N failed | M passed | K skipped (Xms)`.
 * @param entry - Streamed result entry of one package.
 * @param styles - Palette to paint with.
 * @returns The status line.
 */
export function formatStreamingProgressLine(entry: StreamingResultEntry, styles: Styles): string {
	const label = composeEntryDisplayName(entry.pkg, entry.project);
	const elapsed = styles.dim(`(${entry.elapsedMs.toString()}ms)`);

	return `${styles.location("▶")} ${label}  ${formatBreakdown(entry, styles)} ${elapsed}`;
}

function pushPart({ colorize, count, label, parts }: PushPartOptions): void {
	if (count > 0) {
		parts.push(colorize(`${count.toString()} ${label}`));
	}
}

function formatBreakdown(entry: StreamingResultEntry, styles: Styles): string {
	const parts: Array<string> = [];
	pushPart({ colorize: styles.status.fail, count: entry.numFailedTests, label: "failed", parts });
	pushPart({ colorize: styles.status.pass, count: entry.numPassedTests, label: "passed", parts });
	pushPart({
		colorize: styles.status.pending,
		count: entry.numPendingTests,
		label: "skipped",
		parts,
	});
	return parts.length > 0 ? parts.join(" | ") : "0 tests";
}
