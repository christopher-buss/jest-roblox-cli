import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { buildIstanbulHtmlAssetsModule } from "../loaders/istanbul-html-assets.mjs";
import { load, resolve } from "../loaders/luau-raw.mjs";

function temporaryLuauUrl(content: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "luau-raw-"));
	const luauPath = path.join(directory, "runner.luau");
	fs.writeFileSync(luauPath, content, "utf-8");
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	return pathToFileURL(luauPath).href;
}

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

		const result = load(
			temporaryLuauUrl("print('hello')"),
			{ format: "luau-raw" },
			mockNextLoad(),
		);

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

		const result = load(
			"virtual:istanbul-html-assets",
			{ format: "istanbul-html-assets" },
			mockNextLoad(),
		);

		expect(result.source).toBe(buildIstanbulHtmlAssetsModule());
	});

	it("should delegate to nextLoad for other formats", () => {
		expect.assertions(1);

		const next = mockNextLoad();
		load("file:///index.js", { format: "module" }, next);

		expect(next).toHaveBeenCalledOnce();
	});
});
