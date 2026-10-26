import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { buildIstanbulHtmlAssetsModule } from "../loaders/istanbul-html-assets.mjs";
import { load, resolve } from "../loaders/luau-raw.mjs";
import { buildRunnerPluginSourcesModule } from "../loaders/runner-plugin-sources.mjs";

const requireFromTest = createRequire(import.meta.url);
const LUAU_FIXTURE_URL = pathToFileURL(
	requireFromTest.resolve("#test/fixtures/luau-raw/runner.luau"),
).href;

function mockNextResolve(url: string) {
	return vi.fn<Parameters<typeof resolve>[2]>().mockReturnValue({ url });
}

function mockNextLoad() {
	return vi
		.fn<Parameters<typeof load>[2]>()
		.mockReturnValue({ format: "module", source: "// original" });
}

describe(resolve, () => {
	it("should assign luau-raw format when resolved URL ends with .luau", () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///project/src/runner.luau");
		const result = resolve("./runner.luau", {}, next);

		expect(result.format).toBe("luau-raw");
	});

	it("should assign luau-raw format when resolved URL ends with .lua", () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///node_modules/@rbxts/react-globals/src/init.lua");
		const result = resolve("@rbxts/react-globals", {}, next);

		expect(result.format).toBe("luau-raw");
	});

	it("should claim the virtual asset module before node resolves it", () => {
		expect.assertions(2);

		// Nothing on disk answers the specifier, so it never reaches `next`.
		const next = mockNextResolve("file:///unused");
		const result = resolve("virtual:istanbul-html-assets", {}, next);

		expect(result.url).toBe("virtual:istanbul-html-assets");
		expect(next).not.toHaveBeenCalled();
	});

	it("should claim the virtual plugin sources module before node resolves it", () => {
		expect.assertions(2);

		const next = mockNextResolve("file:///unused");
		const result = resolve("virtual:runner-plugin-sources", {}, next);

		expect(result.url).toBe("virtual:runner-plugin-sources");
		expect(next).not.toHaveBeenCalled();
	});

	it("should pass through non-lua resolved URLs unchanged", () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///project/src/index.js");
		const result = resolve("./index.js", {}, next);

		expect(result.format).toBeUndefined();
	});
});

describe(load, () => {
	it("should export file content as string for .luau files", () => {
		expect.assertions(1);

		const result = load(LUAU_FIXTURE_URL, { format: "luau-raw" }, mockNextLoad());

		expect(result.source).toBe("export default \"print('hello')\";");
	});

	it("should export empty object for .lua files", () => {
		expect.assertions(1);

		const result = load(
			"file:///node_modules/@rbxts/react-globals/src/init.lua",
			{ format: "luau-raw" },
			mockNextLoad(),
		);

		expect(result.source).toBe("export default {};");
	});

	it("should build the virtual asset module", () => {
		expect.assertions(1);

		const result = load("virtual:istanbul-html-assets", { format: "virtual" }, mockNextLoad());

		expect(result.source).toBe(buildIstanbulHtmlAssetsModule());
	});

	it("should build the virtual plugin sources module", () => {
		expect.assertions(1);

		const result = load("virtual:runner-plugin-sources", { format: "virtual" }, mockNextLoad());

		expect(result.source).toBe(buildRunnerPluginSourcesModule());
	});

	it("should delegate to nextLoad for other formats", () => {
		expect.assertions(1);

		const next = mockNextLoad();
		const context = { format: "module" };
		load("file:///index.js", context, next);

		expect(next).toHaveBeenCalledExactlyOnceWith("file:///index.js", context);
	});
});
