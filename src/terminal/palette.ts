import assert from "node:assert";
import color from "tinyrainbow";
import type { Except } from "type-fest";

import { highlightCode } from "./highlight.ts";

const DEFAULT_SLOW_TEST_THRESHOLD_MS = 300;

/** Wraps text in a style; the plain palette returns it unchanged. */
export type ColorFunc = (text: string) => string;

/**
 * Color functions every formatter paints through, plus the slow-test
 * threshold.
 */
export interface Styles {
	/** Emphasis. */
	bold: ColorFunc;
	/** Diff line colors. */
	diff: {
		/** Expected-side lines. */
		expected: ColorFunc;
		/** Received-side lines. */
		received: ColorFunc;
	};
	/** De-emphasized text. */
	dim: ColorFunc;
	/** Duration colors. */
	duration: {
		/** Durations at or under `slowTestThreshold`. */
		fast: ColorFunc;
		/** Durations over `slowTestThreshold`. */
		slow: ColorFunc;
	};
	/** The FAIL badge. */
	failBadge: ColorFunc;
	/** Syntax-highlights source by file extension; absent when plain. */
	highlight?: ((filePath: string, code: string) => string) | undefined;
	/** Snippet gutter and line numbers. */
	lineNumber: ColorFunc;
	/** Source location headers. */
	location: ColorFunc;
	/** File path parts. */
	path: {
		/** Directory part. */
		dir: ColorFunc;
		/** File name part. */
		file: ColorFunc;
	};
	/** Paints a project name as its badge label. */
	projectLabel: (displayName: string, displayColor?: string) => string;
	/** The RUN badge. */
	runBadge: ColorFunc;
	/** Milliseconds above which a duration is styled as slow. */
	slowTestThreshold: number;
	/** Per-test status text. */
	status: {
		/** Failed tests and errors. */
		fail: ColorFunc;
		/** Passed tests. */
		pass: ColorFunc;
		/** Pending or skipped tests. */
		pending: ColorFunc;
	};
	/** Summary count text. */
	summary: {
		/** Failed counts. */
		failed: ColorFunc;
		/** Passed counts. */
		passed: ColorFunc;
		/** Pending counts. */
		pending: ColorFunc;
	};
	/** The TIMEOUT badge. */
	timeoutBadge: ColorFunc;
}

/** Inputs of `formatProjectBadge`. */
export interface FormatProjectBadgeOptions {
	/** Named badge color; else one is hashed from `displayName`. */
	displayColor?: string | undefined;
	/** Project name shown in the badge. */
	displayName: string;
	/** Palette that paints the label. */
	styles: Styles;
}

type StyleSet = Except<Styles, "slowTestThreshold">;

/**
 * The colour palette every formatter renders through.
 * @param useColor - Pick the ANSI palette over the plain one.
 * @param slowTestThreshold - Milliseconds above which a duration is slow.
 * @returns The palette with the threshold set.
 */
export function createStyles(
	useColor: boolean,
	slowTestThreshold: number = DEFAULT_SLOW_TEST_THRESHOLD_MS,
): Styles {
	return { ...(useColor ? COLOR_STYLE_SET : PLAIN_STYLE_SET), slowTestThreshold };
}

/**
 * Render a duration, colored by the slow-test threshold.
 * @param ms - Duration in milliseconds.
 * @param styles - Palette and threshold.
 * @returns The styled ` <n>ms` text.
 */
export function formatDuration(ms: number, styles: Styles): string {
	const colorFunc = ms > styles.slowTestThreshold ? styles.duration.slow : styles.duration.fast;
	return colorFunc(` ${ms}${styles.dim("ms")}`);
}

/**
 * Render the `▶ name` project badge.
 * @param options - Project name, color name and palette.
 * @returns The badge text.
 */
export function formatProjectBadge({
	displayColor,
	displayName,
	styles,
}: FormatProjectBadgeOptions): string {
	return `▶ ${styles.projectLabel(displayName, displayColor)}`;
}

/**
 * The no-op color function.
 * @param text - Text to return.
 * @returns `text` unchanged.
 */
export function identity(text: string): string {
	return text;
}

const PLAIN_STYLE_SET: StyleSet = {
	bold: identity,
	diff: { expected: identity, received: identity },
	dim: identity,
	duration: { fast: identity, slow: identity },
	failBadge: identity,
	lineNumber: identity,
	location: identity,
	path: { dir: identity, file: identity },
	projectLabel: identity,
	runBadge: identity,
	status: { fail: identity, pass: identity, pending: identity },
	summary: { failed: identity, passed: identity, pending: identity },
	timeoutBadge: identity,
};

const COLOR_STYLE_SET: StyleSet = {
	bold: color.bold,
	diff: {
		expected: color.green,
		received: color.red,
	},
	dim: color.dim,
	duration: {
		fast: color.green,
		slow: color.yellow,
	},
	failBadge: (text) => color.bgRed(color.white(color.bold(text))),
	highlight: highlightCode,
	lineNumber: color.gray,
	location: color.cyan,
	path: {
		dir: color.dim,
		file: color.bold,
	},
	projectLabel: (displayName, displayColor) => {
		return resolveBadgeColor(displayName, displayColor)(` ${displayName} `);
	},
	runBadge: (text) => color.bgCyan(color.black(color.bold(text))),
	status: {
		fail: color.red,
		pass: color.green,
		pending: color.yellow,
	},
	summary: {
		failed: (text) => color.bold(color.red(text)),
		passed: (text) => color.bold(color.green(text)),
		pending: (text) => color.bold(color.yellow(text)),
	},
	timeoutBadge: (text) => color.bgYellow(color.black(color.bold(text))),
};

const PROJECT_BADGE_COLORS: Array<ColorFunc> = [
	(text) => color.bgYellow(color.black(text)),
	(text) => color.bgCyan(color.black(text)),
	(text) => color.bgGreen(color.black(text)),
	(text) => color.bgMagenta(color.black(text)),
];

const NAMED_BADGE_COLORS = new Map<string, ColorFunc>([
	["blue", (text) => color.bgBlue(color.white(text))],
	["cyan", (text) => color.bgCyan(color.black(text))],
	["green", (text) => color.bgGreen(color.black(text))],
	["magenta", (text) => color.bgMagenta(color.black(text))],
	["red", (text) => color.bgRed(color.white(text))],
	["white", (text) => color.bgWhite(color.black(text))],
	["yellow", (text) => color.bgYellow(color.black(text))],
]);

function hashProjectName(name: string): number {
	let hash = 0;
	for (let index = 0; index < name.length; index++) {
		hash += name.charCodeAt(index) + index;
	}

	return hash % PROJECT_BADGE_COLORS.length;
}

function resolveBadgeColor(displayName: string, displayColor?: string): ColorFunc {
	if (displayColor !== undefined) {
		const named = NAMED_BADGE_COLORS.get(displayColor);
		if (named !== undefined) {
			return named;
		}
	}

	const hashed = PROJECT_BADGE_COLORS[hashProjectName(displayName)];
	assert(hashed !== undefined);
	return hashed;
}
