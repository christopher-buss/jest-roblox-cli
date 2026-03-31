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
});
