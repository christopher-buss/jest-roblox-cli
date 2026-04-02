import { describe, expect, it } from "vitest";

import { deriveCoverageFromIncludes } from "./derive-coverage-from.ts";

describe(deriveCoverageFromIncludes, () => {
	it("should derive coverage patterns from project include roots", () => {
		expect.assertions(1);

		const projects = [{ include: ["packages/src/**/*.spec.ts"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual(["packages/src/**/*.ts", "!**/*.spec.ts", "!**/*.test.ts"]);
	});

	it("should deduplicate roots from multiple projects", () => {
		expect.assertions(1);

		const projects = [{ include: ["src/**/*.spec.ts"] }, { include: ["src/**/*.test.ts"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual(["src/**/*.ts", "!**/*.spec.ts", "!**/*.test.ts"]);
	});

	it("should handle multiple distinct roots", () => {
		expect.assertions(1);

		const projects = [{ include: ["packages/core/**/*.spec.ts", "packages/ui/**/*.spec.ts"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual([
			"packages/core/**/*.ts",
			"packages/ui/**/*.ts",
			"!**/*.spec.ts",
			"!**/*.test.ts",
		]);
	});

	it("should return undefined when no projects provided", () => {
		expect.assertions(1);

		expect(deriveCoverageFromIncludes([])).toBeUndefined();
	});

	it("should return undefined when no roots extractable", () => {
		expect.assertions(1);

		const projects = [{ include: [] as Array<string> }];

		expect(deriveCoverageFromIncludes(projects)).toBeUndefined();
	});

	it("should return undefined when pattern has valid extension but no static root", () => {
		expect.assertions(1);

		const projects = [{ include: ["**/*.spec.ts"] }];

		expect(deriveCoverageFromIncludes(projects)).toBeUndefined();
	});

	it("should derive luau coverage patterns from luau include patterns", () => {
		expect.assertions(1);

		const projects = [{ include: ["packages/friends/src/**/*.spec.luau"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual([
			"packages/friends/src/**/*.luau",
			"!**/*.spec.luau",
			"!**/*.test.luau",
		]);
	});

	it("should derive lua coverage patterns from lua include patterns", () => {
		expect.assertions(1);

		const projects = [{ include: ["src/**/*.spec.lua"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual(["src/**/*.lua", "!**/*.spec.lua", "!**/*.test.lua"]);
	});

	it("should derive patterns for mixed ts and luau projects", () => {
		expect.assertions(1);

		const projects = [
			{ include: ["packages/ts-lib/src/**/*.spec.ts"] },
			{ include: ["packages/luau-lib/src/**/*.spec.luau"] },
		];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual([
			"packages/ts-lib/src/**/*.ts",
			"packages/luau-lib/src/**/*.luau",
			"!**/*.spec.ts",
			"!**/*.test.ts",
			"!**/*.spec.luau",
			"!**/*.test.luau",
		]);
	});

	it("should derive tsx coverage patterns from tsx include patterns", () => {
		expect.assertions(1);

		const projects = [{ include: ["src/**/*.spec.tsx"] }];

		const result = deriveCoverageFromIncludes(projects);

		expect(result).toStrictEqual(["src/**/*.tsx", "!**/*.spec.tsx", "!**/*.test.tsx"]);
	});

	it("should throw when include pattern has no recognizable test extension", () => {
		expect.assertions(1);

		const projects = [{ include: ["src/**/*"] }];

		expect(() => deriveCoverageFromIncludes(projects)).toThrow(
			/cannot infer source extension/i,
		);
	});
});
