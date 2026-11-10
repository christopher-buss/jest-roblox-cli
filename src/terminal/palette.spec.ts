import color from "tinyrainbow";
import { describe, expect, it } from "vitest";

import { createStyles, formatDuration, formatProjectBadge } from "./palette.ts";

describe(formatProjectBadge, () => {
	it("should render every named color", () => {
		expect.assertions(1);

		expect(
			["blue", "cyan", "green", "magenta", "red", "white", "yellow"].map((displayColor) => {
				return formatProjectBadge({
					displayColor,
					displayName: "project",
					styles: createStyles(true),
				});
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
			["d", "a", "b", "c", "aa"].map((name) => {
				return formatProjectBadge({ displayName: name, styles: createStyles(true) });
			}),
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

		expect(
			formatProjectBadge({
				displayColor: "red",
				displayName: "plain",
				styles: createStyles(false),
			}),
		).toBe("▶ plain");
	});
});

describe(createStyles, () => {
	it("should paint the RUN badge black on cyan in bold", () => {
		expect.assertions(1);

		expect(createStyles(true).runBadge(" RUN ")).toBe(
			color.bgCyan(color.black(color.bold(" RUN "))),
		);
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

describe(formatProjectBadge, () => {
	it("should return plain text when color is disabled", () => {
		expect.assertions(1);

		const output = formatProjectBadge({ displayName: "core", styles: createStyles(false) });

		expect(output).toBe("▶ core");
	});

	it("should apply named displayColor when provided", () => {
		expect.assertions(2);

		const output = formatProjectBadge({
			displayColor: "red",
			displayName: "core",
			styles: createStyles(true),
		});

		expect(output).toContain("core");
		expect(output).not.toBe("▶ core");
	});

	it("should fall back to hash-based color for unknown displayColor", () => {
		expect.assertions(2);

		const output = formatProjectBadge({
			displayColor: "nonexistent",
			displayName: "core",
			styles: createStyles(true),
		});

		expect(output).toContain("core");
		expect(output).not.toBe("▶ core");
	});

	it("should treat Object prototype names as unknown displayColors", () => {
		expect.assertions(1);

		expect(
			formatProjectBadge({
				displayColor: "toString",
				displayName: "core",
				styles: createStyles(true),
			}),
		).toBe(formatProjectBadge({ displayName: "core", styles: createStyles(true) }));
	});

	it("should apply all named displayColors", () => {
		expect.assertions(1);

		const colors = ["blue", "cyan", "green", "magenta", "red", "white", "yellow"];

		const badges = colors.map((colorName) => {
			return formatProjectBadge({
				displayColor: colorName,
				displayName: "x",
				styles: createStyles(true),
			});
		});

		expect(badges).not.toContain("▶ x");
	});

	it("should use all hash-based badge colors", () => {
		expect.assertions(1);

		// d→0 (bgYellow), a→1 (bgCyan), b→2 (bgGreen), c→3 (bgMagenta)
		const names = ["d", "a", "b", "c"];

		const badges = names.map((name) => {
			return formatProjectBadge({ displayName: name, styles: createStyles(true) });
		});

		expect(badges).not.toIncludeAnyMembers(names.map((name) => `▶ ${name}`));
	});
});
