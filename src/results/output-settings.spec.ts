import { describe, expect, it } from "vitest";

import { toOutputSettings } from "./output-settings.ts";

describe(toOutputSettings, () => {
	it("should flag coverage on for a run whose coverage report holds only a notice", () => {
		expect.assertions(1);

		const settings = toOutputSettings(
			{
				color: true,
				formatters: ["agent"],
				gameOutput: "/g.log",
				outputFile: "/o.json",
				showLuau: false,
				silent: true,
				slowTestThreshold: 3,
				verbose: true,
			},
			{
				coverage: { notice: "no data", units: [] },
				perUnitGameOutput: true,
				perUnitOutputFile: false,
				rootDir: "/root",
			},
		);

		expect(settings).toStrictEqual({
			collectCoverage: true,
			color: true,
			formatters: ["agent"],
			gameOutput: "/g.log",
			outputFile: "/o.json",
			perUnitGameOutput: true,
			perUnitOutputFile: false,
			rootDir: "/root",
			showLuau: false,
			silent: true,
			slowTestThreshold: 3,
			verbose: true,
		});
	});
});
