import color from "tinyrainbow";
import { describe, expect, it } from "vitest";

import { createStyles, formatDuration, formatProjectBadge } from "./styles.ts";

describe(formatProjectBadge, () => {
	it("should render every named color", () => {
		expect.assertions(1);

		expect(
			["blue", "cyan", "green", "magenta", "red", "white", "yellow"].map((displayColor) => {
				return formatProjectBadge("project", true, displayColor);
			}),
		).toStrictEqual([
			`▶ ${color.bgBlue(color.white(" project "))}`,
			`▶ ${color.bgCyan(color.black(" project "))}`,
			`▶ ${color.bgGreen(color.black(" project "))}`,
			`▶ ${color.bgMagenta(color.black(" project "))}`,
			`▶ ${color.bgRed(color.white(" project "))}`,
			`▶ ${color.bgWhite(color.black(" project "))}`,
			`▶ ${color.bgYellow(color.black(" project "))}`,
		]);
	});

	it("should hash unnamed projects across the complete palette", () => {
		expect.assertions(1);

		expect(
			["d", "a", "b", "c", "aa"].map((name) => formatProjectBadge(name, true)),
		).toStrictEqual([
			`▶ ${color.bgYellow(color.black(" d "))}`,
			`▶ ${color.bgCyan(color.black(" a "))}`,
			`▶ ${color.bgGreen(color.black(" b "))}`,
			`▶ ${color.bgMagenta(color.black(" c "))}`,
			`▶ ${color.bgMagenta(color.black(" aa "))}`,
		]);
	});

	it("should render plain project names without an ANSI label", () => {
		expect.assertions(1);

		expect(formatProjectBadge("plain", false, "red")).toBe("▶ plain");
	});
});

describe(formatDuration, () => {
	it("should switch from the fast to slow style only above the threshold", () => {
		expect.assertions(1);

		const styles = createStyles(true, 10);

		expect([formatDuration(10, styles), formatDuration(11, styles)]).toStrictEqual([
			color.green(` 10${color.dim("ms")}`),
			color.yellow(` 11${color.dim("ms")}`),
		]);
	});
});
