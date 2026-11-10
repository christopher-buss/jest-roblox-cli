import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { resolveCoverageLayout } from "./coverage-layout.ts";

describe(resolveCoverageLayout, () => {
	it("should keep relative paths when rootDir is the cwd", () => {
		expect.assertions(1);

		expect(resolveCoverageLayout(process.cwd())).toStrictEqual({
			buildManifestPath: path.join(".jest-roblox", "coverage", "build-manifest.json"),
			manifestPath: path.join(".jest-roblox", "coverage", "coverage-manifest.json"),
			placeDirectory: path.join(".jest-roblox", "place"),
			placeFile: path.join(".jest-roblox", "place", "game.rbxl"),
			rootPrefix: "",
			shadowRoot: path.join(".jest-roblox", "coverage"),
		});
	});

	it("should place everything under rootDir when it is not the cwd", () => {
		expect.assertions(2);

		const rootDirectory = path.resolve("/elsewhere/pkg");
		const layout = resolveCoverageLayout(rootDirectory);

		expect(layout.rootPrefix).toBe(rootDirectory);
		expect(layout.manifestPath).toBe(
			path.join(rootDirectory, ".jest-roblox", "coverage", "coverage-manifest.json"),
		);
	});
});
