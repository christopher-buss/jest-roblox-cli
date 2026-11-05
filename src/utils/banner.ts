import process from "node:process";
import color from "tinyrainbow";

const SEPARATOR = "⎯";

type BannerLevel = "error" | "warn";

interface BannerBarOptions {
	level: BannerLevel;
	termWidth?: number;
	title: string;
}

interface BannerOptions extends BannerBarOptions {
	body: Array<string>;
}

const levelStyles = {
	error: {
		badge: (text) => color.bgRed(color.white(color.bold(text))),
		separator: color.red,
	},
	warn: {
		badge: (text) => color.bgYellow(color.black(color.bold(text))),
		separator: color.yellow,
	},
} satisfies Record<
	BannerLevel,
	{ badge: (text: string) => string; separator: (text: string) => string }
>;

/**
 * Render a separator bar with a colored title badge centered in it.
 * @param options - The level, title and terminal width.
 * @param options.level - Picks the colors.
 * @param options.termWidth - Bar width; defaults to stderr's columns or 80.
 * @param options.title - The badge text.
 * @returns The colored bar.
 */
export function formatBannerBar({ level, termWidth, title }: BannerBarOptions): string {
	const width = termWidth ?? getDefaultWidth();
	const styles = levelStyles[level];
	const badgeText = ` ${title} `;
	const badge = styles.badge(badgeText);
	const remaining = width - badgeText.length;
	const leftWidth = Math.max(1, Math.floor(remaining / 2));
	const rightWidth = Math.max(1, remaining - leftWidth);

	return `${styles.separator(SEPARATOR.repeat(leftWidth))}${badge}${styles.separator(SEPARATOR.repeat(rightWidth))}`;
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
	const width = termWidth ?? getDefaultWidth();
	const styles = levelStyles[level];
	const header = formatBannerBar({ level, termWidth: width, title });
	const closing = styles.separator(SEPARATOR.repeat(width));
	const bodySection = body.length > 0 ? `\n${body.join("\n")}\n` : "";

	return `\n${header}\n${bodySection}\n${closing}\n\n`;
}

function getDefaultWidth(): number {
	return process.stderr.columns || 80;
}
