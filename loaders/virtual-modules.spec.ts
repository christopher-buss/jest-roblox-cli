import { describe, expect, it } from "vitest";

import { virtualModulesPlugin } from "./virtual-modules.mjs";

describe(virtualModulesPlugin, () => {
	it("should resolve and build a virtual module in the bundle", () => {
		expect.assertions(2);

		const plugin = virtualModulesPlugin();

		expect(plugin.resolveId("virtual:istanbul-html-assets")).toStrictEqual({
			id: "virtual:istanbul-html-assets",
			external: false,
		});
		expect(plugin.load("virtual:istanbul-html-assets")).toStartWith(
			'export default {"html":[{"name":"base.css"',
		);
	});

	it("should name itself for build diagnostics", () => {
		expect.assertions(1);

		expect(virtualModulesPlugin().name).toBe("virtual-modules");
	});

	it("should leave every other module to the next plugin", () => {
		expect.assertions(2);

		const plugin = virtualModulesPlugin();

		expect(plugin.resolveId("./index.ts")).toBeUndefined();
		expect(plugin.load("/repo/src/index.ts")).toBeUndefined();
	});
});
