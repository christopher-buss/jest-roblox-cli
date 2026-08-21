import assert from "node:assert";
import color from "tinyrainbow";
import type { Except } from "type-fest";

const DEFAULT_SLOW_TEST_THRESHOLD_MS = 300;

export type ColorFunc = (text: string) => string;

export interface Styles {
	diff: {
		expected: ColorFunc;
		received: ColorFunc;
	};
	dim: ColorFunc;
	duration: {
		fast: ColorFunc;
		slow: ColorFunc;
	};
	failBadge: ColorFunc;
	lineNumber: ColorFunc;
	location: ColorFunc;
	path: {
		dir: ColorFunc;
		file: ColorFunc;
	};
	runBadge: ColorFunc;
	slowTestThreshold: number;
	status: {
		fail: ColorFunc;
		pass: ColorFunc;
		pending: ColorFunc;
	};
	summary: {
		failed: ColorFunc;
		passed: ColorFunc;
		pending: ColorFunc;
	};
}

type StyleSet = Except<Styles, "slowTestThreshold">;

/**
 * The colour palette every formatter renders through. `slowTestThreshold` is
 * the only per-run value, so the two palettes themselves are module-level
 * constants and this only stamps the threshold onto the chosen one.
 */
export function createStyles(
	useColor: boolean,
	slowTestThreshold: number = DEFAULT_SLOW_TEST_THRESHOLD_MS,
): Styles {
	return { ...(useColor ? COLOR_STYLE_SET : PLAIN_STYLE_SET), slowTestThreshold };
}

export function formatDuration(ms: number, styles: Styles): string {
	const colorFunc = ms > styles.slowTestThreshold ? styles.duration.slow : styles.duration.fast;
	return colorFunc(` ${ms}${styles.dim("ms")}`);
}

export function formatProjectBadge(
	displayName: string,
	useColor: boolean,
	displayColor?: string,
): string {
	if (!useColor) {
		return `▶ ${displayName}`;
	}

	const label = resolveBadgeColor(displayName, displayColor)(` ${displayName} `);
	return `▶ ${label}`;
}

function identity(text: string): string {
	return text;
}

const PLAIN_STYLE_SET: StyleSet = {
	diff: { expected: identity, received: identity },
	dim: identity,
	duration: { fast: identity, slow: identity },
	failBadge: identity,
	lineNumber: identity,
	location: identity,
	path: { dir: identity, file: identity },
	runBadge: identity,
	status: { fail: identity, pass: identity, pending: identity },
	summary: { failed: identity, passed: identity, pending: identity },
};

const COLOR_STYLE_SET: StyleSet = {
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
	lineNumber: color.gray,
	location: color.cyan,
	path: {
		dir: color.dim,
		file: color.bold,
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
	assert(hashed !== undefined, "hash always returns valid index");
	return hashed;
}
