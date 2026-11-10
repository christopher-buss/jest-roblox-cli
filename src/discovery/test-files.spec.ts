import { describe, expect, it } from "vitest";

import { classifyTestFiles } from "./test-files.ts";

describe(classifyTestFiles, () => {
	const files = ["a.spec.ts", "b.spec-d.ts", "c.test-d.ts", "d.test.ts"];

	it("should exclude type test files from runtime even when typecheck is off", () => {
		expect.assertions(1);

		expect(classifyTestFiles(files, { enabled: false, only: false })).toStrictEqual({
			runtimeFiles: ["a.spec.ts", "d.test.ts"],
			typeTestFiles: [],
		});
	});

	it("should split runtime and type test files when typecheck is on", () => {
		expect.assertions(1);

		expect(classifyTestFiles(files, { enabled: true, only: false })).toStrictEqual({
			runtimeFiles: ["a.spec.ts", "d.test.ts"],
			typeTestFiles: ["b.spec-d.ts", "c.test-d.ts"],
		});
	});

	it("should classify luau type test files as type tests", () => {
		expect.assertions(1);

		const luauFiles = ["a.spec.luau", "b.spec-d.luau", "c.test-d.luau"];

		expect(classifyTestFiles(luauFiles, { enabled: true, only: false })).toStrictEqual({
			runtimeFiles: ["a.spec.luau"],
			typeTestFiles: ["b.spec-d.luau", "c.test-d.luau"],
		});
	});

	it("should return no runtime files when typecheckOnly is set", () => {
		expect.assertions(1);

		expect(classifyTestFiles(files, { enabled: true, only: true })).toStrictEqual({
			runtimeFiles: [],
			typeTestFiles: ["b.spec-d.ts", "c.test-d.ts"],
		});
	});
});
