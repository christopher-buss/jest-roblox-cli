import { describe, expect, it } from "vitest";

import { collectTestDefinitions } from "./collect.ts";
import type { TestDefinition } from "./types.ts";

describe(collectTestDefinitions, () => {
	it("should collect a single it block", () => {
		expect.assertions(2);

		const source = 'it("should work", () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(1);
		expect(definitions[0]).toStrictEqual({
			name: "should work",
			ancestorNames: [],
			end: 27,
			start: 0,
			type: "test",
		});
	});

	it("should collect test as alias for it", () => {
		expect.assertions(2);

		const source = 'test("should work", () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(1);
		expect(definitions[0]!.type).toBe("test");
	});

	it("should collect describe wrapping it with correct ancestors", () => {
		expect.assertions(3);

		const source = 'describe("math", () => { it("should add", () => {}); });';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(2);
		expect(definitions[0]!.type).toBe("suite");
		expect(definitions[1]).toStrictEqual(
			expect.objectContaining({
				name: "should add",
				ancestorNames: ["math"],
				type: "test",
			}),
		);
	});

	it("should handle nested describe blocks", () => {
		expect.assertions(2);

		const source = `
describe("outer", () => {
	describe("inner", () => {
		it("should work", () => {});
	});
});`;
		const definitions = collectTestDefinitions(source);
		const testDefinition = definitions.find((item: TestDefinition) => item.type === "test");

		expect(testDefinition).toBeDefined();
		expect(testDefinition!.ancestorNames).toStrictEqual(["outer", "inner"]);
	});

	it("should return empty array for file with no test blocks", () => {
		expect.assertions(1);

		const source = "const x: number = 1; function foo() { return x; }";
		const definitions = collectTestDefinitions(source);

		expect(definitions).toBeEmpty();
	});

	it("should handle TypeScript syntax without errors", () => {
		expect.assertions(1);

		const source = `
import { expectTypeOf } from "@rbxts/jest-utils";
describe("types", () => {
	it("should accept generics", () => {
		expectTypeOf<Vector3["Add"]>().returns.toEqualTypeOf<Vector3>();
	});
});`;
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(2);
	});

	it("should collect it.skip and describe.skip", () => {
		expect.assertions(2);

		const source = 'describe.skip("skipped", () => { it.skip("also skipped", () => {}); });';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(2);
		expect(definitions.every((item: TestDefinition) => item.name !== "")).toBeTrue();
	});

	it("should handle template literal test names", () => {
		expect.assertions(1);

		const source = "it(`should handle template`, () => {});";
		const definitions = collectTestDefinitions(source);

		expect(definitions[0]!.name).toBe("should handle template");
	});

	it("should pop suite stack when sibling suites are sequential", () => {
		expect.assertions(2);

		const source = `
describe("first", () => { it("should a", () => {}); });
describe("second", () => { it("should b", () => {}); });`;
		const definitions = collectTestDefinitions(source);
		const tests = definitions.filter((item: TestDefinition) => item.type === "test");

		expect(tests[0]!.ancestorNames).toStrictEqual(["first"]);
		expect(tests[1]!.ancestorNames).toStrictEqual(["second"]);
	});

	it("should handle template literal with interpolation", () => {
		expect.assertions(1);

		// eslint-disable-next-line no-template-curly-in-string -- testing template literal parsing
		const source = "const x = 'y'; it(`should handle ${x}`, () => {});";
		const definitions = collectTestDefinitions(source);

		expect(definitions[0]!.name).toContain("should handle");
	});

	it("should handle variable reference as test name", () => {
		expect.assertions(1);

		const source = 'const name = "test"; it(name, () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions[0]!.name).toBe("name");
	});

	it("should ignore test call with no arguments", () => {
		expect.assertions(1);

		const source = "it();";
		const definitions = collectTestDefinitions(source);

		expect(definitions).toBeEmpty();
	});

	it("should ignore member expression on non-test object", () => {
		expect.assertions(1);

		const source = 'foo.bar("hello", () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toBeEmpty();
	});

	it("should ignore non-test function calls", () => {
		expect.assertions(1);

		const source = 'console.log("hello"); foo(); it("should work", () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toHaveLength(1);
	});

	it("should ignore calls with computed callee", () => {
		expect.assertions(1);

		const source = 'const fns = [it]; fns[0]("should work", () => {});';
		const definitions = collectTestDefinitions(source);

		expect(definitions).toBeEmpty();
	});

	it("should handle multiple sibling test blocks", () => {
		expect.assertions(3);

		const source = `
describe("suite", () => {
	it("should first", () => {});
	it("should second", () => {});
});`;
		const definitions = collectTestDefinitions(source);
		const tests = definitions.filter((item: TestDefinition) => item.type === "test");

		expect(tests).toHaveLength(2);
		expect(tests[0]!.ancestorNames).toStrictEqual(["suite"]);
		expect(tests[1]!.ancestorNames).toStrictEqual(["suite"]);
	});
});
