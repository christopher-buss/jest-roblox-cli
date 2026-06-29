import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { load as LoadFunc, resolve as ResolveFunc } from "../loaders/luau-raw.mjs";

vi.mock<typeof import("node:fs")>(import("node:fs"));

const { load, resolve }: { load: typeof LoadFunc; resolve: typeof ResolveFunc } =
	await import("../loaders/luau-raw.mjs");

function mockNextResolve(url: string) {
	return vi.fn<Parameters<typeof ResolveFunc>[2]>().mockReturnValue({
		format: undefined,
		url,
	});
}

function mockNextLoad() {
	return vi
		.fn<Parameters<typeof LoadFunc>[2]>()
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

		vi.mocked(fs.readFileSync).mockReturnValue("print('hello')");

		const result = load(
			"file:///D:/project/src/runner.luau",
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

	it("should delegate to nextLoad for other formats", () => {
		expect.assertions(1);

		const next = mockNextLoad();
		load("file:///index.js", { format: "module" }, next);

		expect(next).toHaveBeenCalledOnce();
	});
});
