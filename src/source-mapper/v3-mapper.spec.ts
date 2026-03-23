import * as fs from "node:fs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { clearMapCache, getSourceContent, mapFromSourceMap } from "./v3-mapper.ts";

vi.mock(import("node:fs"));

describe(mapFromSourceMap, () => {
	it("should return undefined when no .map file exists", () => {
		expect.assertions(1);

		onTestFinished(clearMapCache);

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = mapFromSourceMap("output.luau", 1);

		expect(result).toBeUndefined();
	});

	it("should return mapped position from valid V3 sourcemap", () => {
		expect.assertions(3);

		onTestFinished(clearMapCache);

		const sourceMap = JSON.stringify({
			file: "output.luau",
			// cspell:ignore AACA
			mappings: "AAAA;AACA",
			sources: ["../src/input.ts"],
			version: 3,
		});

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(sourceMap);

		const result = mapFromSourceMap("output.luau", 1);

		expect(result).toBeDefined();
		expect(result?.source).toBe("../src/input.ts");
		expect(result?.line).toBe(1);
	});

	it("should return undefined for unmapped lines", () => {
		expect.assertions(1);

		onTestFinished(clearMapCache);

		const sourceMap = JSON.stringify({
			file: "output.luau",
			mappings: "AAAA",
			sources: ["../src/input.ts"],
			version: 3,
		});

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(sourceMap);

		const result = mapFromSourceMap("output.luau", 99);

		expect(result).toBeUndefined();
	});

	it("should cache parsed sourcemaps across calls", () => {
		expect.assertions(2);

		onTestFinished(clearMapCache);

		vi.clearAllMocks();

		const sourceMap = JSON.stringify({
			file: "output.luau",
			mappings: "AAAA",
			sources: ["../src/input.ts"],
			version: 3,
		});

		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(sourceMap);

		mapFromSourceMap("cached.luau", 1);
		mapFromSourceMap("cached.luau", 1);

		expect(fs.readFileSync).toHaveBeenCalledOnce();
		expect(fs.existsSync).toHaveBeenCalledOnce();
	});
});

describe(getSourceContent, () => {
	it("should return undefined when map file does not exist", () => {
		expect.assertions(1);

		onTestFinished(clearMapCache);

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = getSourceContent("missing.luau", "source.ts");

		expect(result).toBeUndefined();
	});
});
