import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { generateMaterializerScript } from "./test-script-staged.ts";

describe(generateMaterializerScript, () => {
	it("should embed package list as JSON in the substituted template", () => {
		expect.assertions(2);

		const script = generateMaterializerScript([
			{
				name: "@halcyon/foo",
				config: DEFAULT_CONFIG,
				testFiles: ["src/foo.spec.ts"],
			},
		]);

		expect(script).toContain('"pkg":"@halcyon/foo"');
		expect(script).toContain("Jest.runCLI");
	});

	it("should include the package's testMatch in the substituted Jest argv", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{
				name: "@halcyon/foo",
				config: { ...DEFAULT_CONFIG, testMatch: ["**/*.spec.ts"] },
				testFiles: ["src/foo.spec.ts"],
			},
		]);

		expect(script).toContain('"testMatch":["**/*.spec"]');
	});

	it("should include jestPath in the substituted Jest argv when set", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{
				name: "@halcyon/foo",
				config: {
					...DEFAULT_CONFIG,
					jestPath: "ReplicatedStorage/Packages/_Index/Jest",
				},
				testFiles: [],
			},
		]);

		expect(script).toContain('"jestPath":"ReplicatedStorage/Packages/_Index/Jest"');
	});

	it("should embed payload inside a level-2 long-string", () => {
		expect.assertions(1);

		const script = generateMaterializerScript([
			{ name: "@halcyon/foo", config: DEFAULT_CONFIG, testFiles: [] },
		]);

		expect(script).toContain("[==[");
	});

	it("should throw when serialized payload contains the long-string terminator", () => {
		expect.assertions(1);

		expect(() => {
			return generateMaterializerScript([
				{
					name: "@halcyon/foo",
					config: { ...DEFAULT_CONFIG, jestPath: "boom]==]bad" },
					testFiles: [],
				},
			]);
		}).toThrow(/]==]/);
	});
});
