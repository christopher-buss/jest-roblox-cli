import { describe, expect, it } from "vitest";

import { narrowConfigByFiles, narrowForLuauRun } from "./narrow-by-files.ts";
import type { ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

function make(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

describe(narrowConfigByFiles, () => {
	it("should return config unchanged when files is empty", () => {
		expect.assertions(1);

		const config = make({ testPathPattern: "existing" });

		expect(narrowConfigByFiles(config, [])).toBe(config);
	});

	it("should set testPathPattern to a wrapped basename pattern when one file given", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), ["src/foo/bar.test.ts"]);

		expect(result.testPathPattern).toBe("(bar\\.test)");
	});

	it("should join multiple file basename patterns inside one alternation group", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), [
			"src/foo/use-spring.test.ts",
			"src/bar/use-trail.test.tsx",
		]);

		expect(result.testPathPattern).toBe("(use-spring\\.test|use-trail\\.test)");
	});

	it("should normalize Windows backslashes when extracting basename", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), ["src\\client\\__tests__\\use-spring.test.tsx"]);

		expect(result.testPathPattern).toBe("(use-spring\\.test)");
	});

	it("should handle a bare filename with no parent directory", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), ["foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should strip .ts/.tsx/.lua/.luau extensions from each basename", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), [
			"a.test.ts",
			"b.test.tsx",
			"c.test.lua",
			"d.test.luau",
		]);

		expect(result.testPathPattern).toBe("(a\\.test|b\\.test|c\\.test|d\\.test)");
	});

	it("should escape regex metacharacters in the basename", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), ["src/(foo).test.ts"]);

		expect(result.testPathPattern).toBe("(\\(foo\\)\\.test)");
	});

	it("should append an existing testPathPattern as another alternation branch", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make({ testPathPattern: "cleanup" }), [
			"src/foo.test.ts",
		]);

		expect(result.testPathPattern).toBe("(foo\\.test|cleanup)");
	});

	it("should treat empty-string existing testPathPattern as absent", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make({ testPathPattern: "" }), ["src/foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should dedupe identical basename patterns when multiple files share a basename", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles(make(), [
			"src/client/foo.test.ts",
			"src/server/foo.test.ts",
		]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should return a new object rather than mutating the input config", () => {
		expect.assertions(2);

		const config = make({ testPathPattern: "existing" });
		const result = narrowConfigByFiles(config, ["src/foo.test.ts"]);

		expect(result).not.toBe(config);
		expect(config.testPathPattern).toBe("existing");
	});
});

describe(narrowForLuauRun, () => {
	it("should return the config untouched when no filter is active", () => {
		expect.assertions(1);

		const config = make({ testPathPattern: "src/foo/bar.spec" });

		expect(narrowForLuauRun(config, ["src/foo/bar.spec.ts"], false)).toBe(config);
	});

	it("should drop the FS pattern and forward a basename pattern when filter is active", () => {
		expect.assertions(1);

		const config = make({ testPathPattern: "src/foo/bar.spec" });
		const result = narrowForLuauRun(config, ["src/foo/bar.spec.ts"], true);

		expect(result.testPathPattern).toBe("(bar\\.spec)");
	});

	it("should clear the FS pattern when filter is active but no files match", () => {
		expect.assertions(1);

		// The raw FS pattern is dropped before the empty-files no-op, so callers
		// that must run zero tests (workspace mode) handle the empty case
		// separately rather than relying on this passthrough.
		const config = make({ testPathPattern: "src/foo/bar.spec" });
		const result = narrowForLuauRun(config, [], true);

		expect(result.testPathPattern).toBeUndefined();
	});
});
