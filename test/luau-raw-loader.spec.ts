import * as fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import type { load as LoadFunc, resolve as ResolveFunc } from "../loaders/luau-raw.mjs";

vi.mock<typeof import("node:fs/promises")>(import("node:fs/promises"));

const { load, resolve }: { load: typeof LoadFunc; resolve: typeof ResolveFunc } =
	await import("../loaders/luau-raw.mjs");

function mockNextResolve(url: string) {
	return vi.fn<Parameters<typeof ResolveFunc>[2]>().mockResolvedValue({
		format: undefined,
		url,
	});
}

function mockNextLoad() {
	return vi
		.fn<Parameters<typeof LoadFunc>[2]>()
		.mockResolvedValue({ format: "module", source: "// original" });
}

describe(resolve, () => {
	it("should assign luau-raw format when resolved URL ends with .luau", async () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///project/src/runner.luau");
		const result = await resolve("./runner.luau", {}, next);

		expect(result.format).toBe("luau-raw");
	});

	it("should assign luau-raw format when resolved URL ends with .lua", async () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///node_modules/@rbxts/react-globals/src/init.lua");
		const result = await resolve("@rbxts/react-globals", {}, next);

		expect(result.format).toBe("luau-raw");
	});

	it("should pass through non-lua resolved URLs unchanged", async () => {
		expect.assertions(1);

		const next = mockNextResolve("file:///project/src/index.js");
		const result = await resolve("./index.js", {}, next);

		expect(result.format).toBeUndefined();
	});
});

describe(load, () => {
	it("should export file content as string for .luau files", async () => {
		expect.assertions(1);

		vi.mocked(fsp.readFile).mockResolvedValue("print('hello')");

		const result = await load(
			"file:///D:/project/src/runner.luau",
			{ format: "luau-raw" },
			mockNextLoad(),
		);

		expect(result.source).toBe("export default \"print('hello')\";");
	});

	it("should export empty object for .lua files", async () => {
		expect.assertions(1);

		const result = await load(
			"file:///node_modules/@rbxts/react-globals/src/init.lua",
			{ format: "luau-raw" },
			mockNextLoad(),
		);

		expect(result.source).toBe("export default {};");
	});

	it("should delegate to nextLoad for other formats", async () => {
		expect.assertions(1);

		const next = mockNextLoad();
		await load("file:///index.js", { format: "module" }, next);

		expect(next).toHaveBeenCalledOnce();
	});
});
