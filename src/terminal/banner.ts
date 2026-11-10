import process from "node:process";

import { createStyles, type Styles } from "./palette.ts";
import { getTerminalWidth } from "./width.ts";

const SEPARATOR = "⎯";

type BannerLevel = "error" | "warn";

interface BannerBarOptions {
	level: BannerLevel;
	styles?: Styles | undefined;
	termWidth?: number;
	title: string;
}

interface BannerOptions extends BannerBarOptions {
	body: Array<string>;
}

const COLOR_STYLES = createStyles(true);

/**
 * Render a separator bar with a colored title badge centered in it.
 * @param options - The level, title and terminal width.
 * @param options.level - Picks the colors.
 * @param options.styles - Palette to paint with; defaults to colour.
 * @param options.termWidth - Bar width; defaults to stderr's columns or 80.
 * @param options.title - The badge text.
 * @returns The colored bar.
 */
export function formatBannerBar({
	level,
	styles = COLOR_STYLES,
	termWidth,
	title,
}: BannerBarOptions): string {
	const width = termWidth ?? getTerminalWidth(process.stderr);
	const { badge: paintBadge, separator } = levelStyles(level, styles);
	const badgeText = ` ${title} `;
	const badge = paintBadge(badgeText);
	const remaining = width - badgeText.length;
	const leftWidth = Math.max(1, Math.floor(remaining / 2));
	const rightWidth = Math.max(1, remaining - leftWidth);

	return `${separator(SEPARATOR.repeat(leftWidth))}${badge}${separator(SEPARATOR.repeat(rightWidth))}`;
}

/**
 * Render a titled bar, the body lines and a closing separator.
 * @param options - The level, title, body and terminal width.
 * @param options.body - The lines between the bars.
 * @param options.level - Picks the colors.
 * @param options.termWidth - Bar width; defaults to stderr's columns or 80.
 * @param options.title - The badge text.
 * @returns The banner, with surrounding blank lines.
 */
export function formatBanner({ body, level, termWidth, title }: BannerOptions): string {
	const width = termWidth ?? getTerminalWidth(process.stderr);
	const header = formatBannerBar({ level, termWidth: width, title });
	const closing = levelStyles(level, COLOR_STYLES).separator(SEPARATOR.repeat(width));
	const bodySection = body.length > 0 ? `\n${body.join("\n")}\n` : "";

	return `\n${header}\n${bodySection}\n${closing}\n\n`;
}

function levelStyles(
	level: BannerLevel,
	styles: Styles,
): { badge: (text: string) => string; separator: (text: string) => string } {
	return level === "error"
		? { badge: styles.failBadge, separator: styles.status.fail }
		: { badge: styles.timeoutBadge, separator: styles.status.pending };
}
