import * as path from "node:path";
import { describe, it } from "vitest";

import { DEFAULT_CONFIG, resolvePlaceFilePath } from "./resolved-config.ts";

describe(resolvePlaceFilePath, () => {
	it("should resolve placeFile against rootDir", ({ expect }) => {
		expect.assertions(1);

		const rootDirectory = path.resolve("/project");

		expect(
			resolvePlaceFilePath({
				...DEFAULT_CONFIG,
				placeFile: "./out/game.rbxl",
				rootDir: rootDirectory,
			}),
		).toBe(path.join(rootDirectory, "out", "game.rbxl"));
	});
});
