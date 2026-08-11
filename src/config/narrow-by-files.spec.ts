import { describe, expect, it } from "vitest";

import { narrowConfigByFiles, narrowForLuauRun } from "./narrow-by-files.ts";
import type { ResolvedConfig } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

// Stands in for a project whose mounts own no part of the file, which is what
// drives the basename fallback.
function noMountOwnsIt(): undefined {}

function make(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...DEFAULT_CONFIG, ...overrides };
}

/** Narrow with no mount ownership, so every file takes the basename branch. */
function byBasename(config: ResolvedConfig, files: Array<string>): ResolvedConfig {
	return narrowConfigByFiles({ config, files, toInstancePath: noMountOwnsIt });
}

describe(narrowConfigByFiles, () => {
	it("should return config unchanged when files is empty", () => {
		expect.assertions(1);

		const config = make({ testPathPattern: "existing" });

		expect(byBasename(config, [])).toBe(config);
	});

	it("should set testPathPattern to a wrapped basename pattern when one file given", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/bar.test.ts"]);

		expect(result.testPathPattern).toBe("(bar\\.test)");
	});

	it("should join multiple file basename patterns inside one alternation group", () => {
		expect.assertions(1);

		const result = byBasename(make(), [
			"src/foo/use-spring.test.ts",
			"src/bar/use-trail.test.tsx",
		]);

		expect(result.testPathPattern).toBe("(use-spring\\.test|use-trail\\.test)");
	});

	it("should normalize Windows backslashes when extracting basename", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src\\client\\__tests__\\use-spring.test.tsx"]);

		expect(result.testPathPattern).toBe("(use-spring\\.test)");
	});

	it("should handle a bare filename with no parent directory", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should strip .ts/.tsx/.lua/.luau extensions from each basename", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["a.test.ts", "b.test.tsx", "c.test.lua", "d.test.luau"]);

		expect(result.testPathPattern).toBe("(a\\.test|b\\.test|c\\.test|d\\.test)");
	});

	it("should escape regex metacharacters in the basename", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/(foo).test.ts"]);

		expect(result.testPathPattern).toBe("(\\(foo\\)\\.test)");
	});

	it("should append an existing testPathPattern as another alternation branch", () => {
		expect.assertions(1);

		const result = byBasename(make({ testPathPattern: "cleanup" }), ["src/foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test|cleanup)");
	});

	it("should treat empty-string existing testPathPattern as absent", () => {
		expect.assertions(1);

		const result = byBasename(make({ testPathPattern: "" }), ["src/foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should dedupe identical basename patterns when multiple files share a basename", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/client/foo.test.ts", "src/server/foo.test.ts"]);

		expect(result.testPathPattern).toBe("(foo\\.test)");
	});

	it("should rename an index basename to init (roblox-ts compiles index to init)", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.spec.ts"]);

		expect(result.testPathPattern).toBe("(init\\.spec)");
	});

	it("should rename a bare index file with no test suffix to init", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.ts"]);

		expect(result.testPathPattern).toBe("(init)");
	});

	it("should rename only the index basename and leave the others unchanged", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.spec.ts", "src/bar/baz.spec.ts"]);

		expect(result.testPathPattern).toBe("(init\\.spec|baz\\.spec)");
	});

	it("should not rename a basename that merely starts with index", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index-helpers.spec.ts"]);

		expect(result.testPathPattern).toBe("(index-helpers\\.spec)");
	});

	it("should not rename a basename that merely ends with index", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/reindex.spec.ts"]);

		expect(result.testPathPattern).toBe("(reindex\\.spec)");
	});

	it("should not rename an index basename for a pure-Luau .luau source", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.spec.luau"]);

		expect(result.testPathPattern).toBe("(index\\.spec)");
	});

	it("should not rename an index basename for a pure-Luau .lua source", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.spec.lua"]);

		expect(result.testPathPattern).toBe("(index\\.spec)");
	});

	it("should use the instance sub-path when a mount owns the file", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles({
			config: make(),
			files: ["src/server/systems/attack/index.test.ts"],
			toInstancePath: () => "systems/attack/init.test",
		});

		expect(result.testPathPattern).toBe("(systems/attack/init\\.test)");
	});

	it("should keep same-basename files apart once the sub-path disambiguates them", () => {
		expect.assertions(1);

		const subPaths = new Map([
			["src/server/a/index.test.ts", "a/init.test"],
			["src/server/b/index.test.ts", "b/init.test"],
		]);
		const result = narrowConfigByFiles({
			config: make(),
			files: ["src/server/a/index.test.ts", "src/server/b/index.test.ts"],
			toInstancePath: (file) => subPaths.get(file),
		});

		expect(result.testPathPattern).toBe("(a/init\\.test|b/init\\.test)");
	});

	it("should fall back to the basename for a file no mount owns", () => {
		expect.assertions(1);

		const result = byBasename(make(), ["src/foo/index.test.ts"]);

		expect(result.testPathPattern).toBe("(init\\.test)");
	});

	it("should escape regex metacharacters in a resolved sub-path", () => {
		expect.assertions(1);

		const result = narrowConfigByFiles({
			config: make(),
			files: ["src/server/(a)/index.test.ts"],
			toInstancePath: () => "(a)/init.test",
		});

		expect(result.testPathPattern).toBe("(\\(a\\)/init\\.test)");
	});

	it("should return a new object rather than mutating the input config", () => {
		expect.assertions(2);

		const config = make({ testPathPattern: "existing" });
		const result = byBasename(config, ["src/foo.test.ts"]);

		expect(result).not.toBe(config);
		expect(config.testPathPattern).toBe("existing");
	});
});

describe(narrowForLuauRun, () => {
	it("should return the config untouched when no filter is active", () => {
		expect.assertions(1);

		const config = make({ testPathPattern: "src/foo/bar.spec" });
		const result = narrowForLuauRun({
			config,
			filterActive: false,
			runtimeFiles: ["src/foo/bar.spec.ts"],
			toInstancePath: noMountOwnsIt,
		});

		expect(result).toBe(config);
	});

	it("should drop the FS pattern and forward a basename pattern when filter is active", () => {
		expect.assertions(1);

		const result = narrowForLuauRun({
			config: make({ testPathPattern: "src/foo/bar.spec" }),
			filterActive: true,
			runtimeFiles: ["src/foo/bar.spec.ts"],
			toInstancePath: noMountOwnsIt,
		});

		expect(result.testPathPattern).toBe("(bar\\.spec)");
	});

	it("should rename an index file to init when filter is active", () => {
		expect.assertions(1);

		const result = narrowForLuauRun({
			config: make({ testPathPattern: "src/foo/index.spec" }),
			filterActive: true,
			runtimeFiles: ["src/foo/index.spec.ts"],
			toInstancePath: noMountOwnsIt,
		});

		expect(result.testPathPattern).toBe("(init\\.spec)");
	});

	it("should forward the instance sub-path when a mount owns the file", () => {
		expect.assertions(1);

		const result = narrowForLuauRun({
			config: make({ testPathPattern: "src/foo/index.spec" }),
			filterActive: true,
			runtimeFiles: ["src/foo/index.spec.ts"],
			toInstancePath: () => "foo/init.spec",
		});

		expect(result.testPathPattern).toBe("(foo/init\\.spec)");
	});

	it("should clear the FS pattern when filter is active but no files match", () => {
		expect.assertions(1);

		// The raw FS pattern is dropped before the empty-files no-op, so callers
		// that must run zero tests (workspace mode) handle the empty case
		// separately rather than relying on this passthrough.
		const result = narrowForLuauRun({
			config: make({ testPathPattern: "src/foo/bar.spec" }),
			filterActive: true,
			runtimeFiles: [],
			toInstancePath: noMountOwnsIt,
		});

		expect(result.testPathPattern).toBeUndefined();
	});
});
