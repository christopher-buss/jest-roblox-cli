import { describe, expect, it } from "vitest";

import generated from "../../luau/protocol.luau";
import { renderLuauProtocol } from "./luau-module.ts";

describe(renderLuauProtocol, () => {
	it("should match the committed module; run scripts/write-luau-protocol.run.ts if not", () => {
		expect.assertions(1);

		expect(generated.replaceAll("\r\n", "\n")).toBe(renderLuauProtocol());
	});

	it("should render nested tables, lists, strings, numbers and booleans", () => {
		expect.assertions(4);

		const source = renderLuauProtocol();

		expect(source).toStartWith("--!strict\n");
		expect(source).toContain("\tstudio = {\n");
		expect(source).toContain('\t\tsideChannelAttribute = "JestRobloxRunSideChannel",\n');
		expect(source).toContain("\t\tprotocolVersion = 12,\n");
	});
});
