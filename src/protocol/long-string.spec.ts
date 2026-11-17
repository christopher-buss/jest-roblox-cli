import { describe, it } from "vitest";

import { embedConfigJson, luauLongString } from "./long-string.ts";

describe(luauLongString, () => {
	it("should open at level one when no terminator occurs", ({ expect }) => {
		expect.assertions(1);

		expect(luauLongString('{"a":1}')).toBe('[=[{"a":1}]=]');
	});

	it("should climb past every terminator level the content holds", ({ expect }) => {
		expect.assertions(1);

		expect(luauLongString("a]=]b]==]c")).toBe("[===[a]=]b]==]c]===]");
	});
});

describe(embedConfigJson, () => {
	it("should replace the placeholder whatever its level", ({ expect }) => {
		expect.assertions(2);

		expect(embedConfigJson("x([=[__CONFIG_JSON__]=])", "{}")).toBe("x([=[{}]=])");
		expect(embedConfigJson("x([==[__CONFIG_JSON__]==])", "]=]")).toBe("x([==[]=]]==])");
	});

	it("should leave a mismatched bracket pair alone", ({ expect }) => {
		expect.assertions(1);

		expect(embedConfigJson("[=[__CONFIG_JSON__]==]", "{}")).toBe("[=[__CONFIG_JSON__]==]");
	});

	it("should embed a payload holding a replacement pattern verbatim", ({ expect }) => {
		expect.assertions(1);

		expect(embedConfigJson("[=[__CONFIG_JSON__]=]", "$&")).toBe("[=[$&]=]");
	});
});
