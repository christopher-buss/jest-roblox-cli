import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { isShardedParallel, pickRunSettings } from "./interface.ts";

describe(isShardedParallel, () => {
	it("should treat one session as serial and larger counts as sharded", () => {
		expect.assertions(2);

		expect(isShardedParallel(1)).toBeFalse();
		expect(isShardedParallel(2)).toBeTrue();
	});

	it("should treat auto as sharded", () => {
		expect.assertions(1);

		expect(isShardedParallel("auto")).toBeTrue();
	});
});

describe(pickRunSettings, () => {
	it("should keep only the run-wide settings of a config", () => {
		expect.assertions(1);

		const config = createResolvedConfig({
			bootProbeTimeout: 5,
			collectCoverage: true,
			placeFile: "place.rbxl",
			rojoProject: "game.project.json",
			rootDir: "/repo",
			timeout: 7,
			uploadCache: false,
		});

		expect(pickRunSettings(config)).toStrictEqual({
			bootProbeTimeout: 5,
			placeFile: "place.rbxl",
			rootDir: "/repo",
			timeout: 7,
			uploadCache: false,
		});
	});
});
