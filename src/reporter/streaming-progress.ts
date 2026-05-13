import color from "tinyrainbow";

import type { StreamingResultEntry } from "../memory-store/sorted-map-client.ts";

export interface ProgressLineOptions {
	color: boolean;
}

/**
 * Build a single-line per-package status string for the streaming
 * progress sink. Format: `▶ <pkg> N passed | M failed | K skipped (Xms)`.
 *
 * The line is intentionally narrow — it lands mid-task while siblings are
 * still running; the full project section (failures, snippets, summary)
 * still renders at task end through the existing batched output path.
 */
export function formatStreamingProgressLine(
	entry: StreamingResultEntry,
	options: ProgressLineOptions,
): string {
	const useColor = options.color;
	const label = formatLabel(entry);
	const dim = useColor ? color.dim : identity;
	const elapsed = dim(`(${entry.elapsedMs.toString()}ms)`);

	const breakdown = formatBreakdown(entry, useColor);
	const arrow = useColor ? color.cyan("▶") : "▶";
	return `${arrow} ${label}  ${breakdown} ${elapsed}`;
}

function identity(text: string): string {
	return text;
}

function pushPart(
	parts: Array<string>,
	count: number,
	label: string,
	colorize: (text: string) => string,
): void {
	if (count > 0) {
		parts.push(colorize(`${count.toString()} ${label}`));
	}
}

function formatBreakdown(entry: StreamingResultEntry, useColor: boolean): string {
	const parts: Array<string> = [];
	pushPart(parts, entry.numPassedTests, "passed", useColor ? color.green : identity);
	pushPart(parts, entry.numFailedTests, "failed", useColor ? color.red : identity);
	pushPart(parts, entry.numPendingTests, "skipped", useColor ? color.yellow : identity);
	return parts.length > 0 ? parts.join(" | ") : "0 tests";
}

function formatLabel(entry: StreamingResultEntry): string {
	return entry.pkg === entry.project ? entry.pkg : `${entry.pkg} › ${entry.project}`;
}
