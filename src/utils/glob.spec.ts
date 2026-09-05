import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createGlobCache, globSync, matchesGlobPattern } from "./glob.ts";

const CWD = "/project";

describe(globSync, () => {
	it("should return empty array for empty directory", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync(CWD, { recursive: true });

		expect(globSync("**/*.ts", { cwd: CWD, fileSystem })).toBeEmpty();
	});

	it("should match files with single wildcard pattern", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "app.ts": "", "readme.md": "", "util.ts": "" }, CWD);

		expect(globSync("*.ts", { cwd: CWD, fileSystem })).toStrictEqual(["app.ts", "util.ts"]);
	});

	it("should match files recursively with double-star pattern", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "root.ts": "", "src/index.ts": "", "src/util.js": "" }, CWD);

		const result = globSync("**/*.ts", { cwd: CWD, fileSystem });

		// **/ matches zero or more path segments (standard glob semantics)
		expect(result).toContain("root.ts");
		expect(result).toContain("src/index.ts");
		expect(result).not.toContain("src/util.js");
	});

	it("should skip node_modules directories", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "node_modules/dep/index.ts": "", "src/app.ts": "" }, CWD);

		expect(globSync("**/*.ts", { cwd: CWD, fileSystem })).toStrictEqual(["src/app.ts"]);
	});

	it("should skip dot directories", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ ".git/hooks/pre-commit.ts": "", "src/app.ts": "" }, CWD);

		expect(globSync("**/*.ts", { cwd: CWD, fileSystem })).toStrictEqual(["src/app.ts"]);
	});

	it("should match files directly in a prefixed doublestar directory", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/init.spec.luau": "" }, CWD);

		expect(globSync("src/**/*.spec.luau", { cwd: CWD, fileSystem })).toStrictEqual([
			"src/init.spec.luau",
		]);
	});

	it("should handle permission errors gracefully", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "app.ts": "" }, CWD);
		vi.spyOn(fileSystem, "readdirSync").mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		expect(globSync("**/*.ts", { cwd: CWD, fileSystem })).toBeEmpty();
	});

	it("should default cwd to process.cwd() when not provided", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		vi.spyOn(process, "cwd").mockReturnValue("/default-cwd");
		volume.fromJSON({ "index.ts": "" }, "/default-cwd");

		expect(globSync("*", { fileSystem })).toStrictEqual(["index.ts"]);
	});

	it("should match root files through a leading ./ in the pattern", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "package.json": "", "src/package.json": "" }, CWD);

		expect(globSync("./package.json", { cwd: CWD, fileSystem })).toStrictEqual([
			"package.json",
		]);
	});

	it("should match dot-extension patterns correctly", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "test.spec.ts": "", "test.ts": "" }, CWD);

		expect(globSync("*.spec.ts", { cwd: CWD, fileSystem })).toStrictEqual(["test.spec.ts"]);
	});
});

describe(matchesGlobPattern, () => {
	it("should only remove a current-directory prefix at the start", () => {
		expect.assertions(2);

		expect(matchesGlobPattern("file.ts", "./file.ts")).toBeTrue();
		expect(matchesGlobPattern("dir/./file.ts", "dir/./file.ts")).toBeTrue();
	});
});

describe("walk caching", () => {
	it("should walk once when a cache is shared across patterns", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/app.spec.ts": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache();
		const readdir = vi.spyOn(fileSystem, "readdirSync");

		expect(globSync("**/*.ts", { cache, cwd: CWD, fileSystem })).toHaveLength(2);

		const afterFirst = readdir.mock.calls.length;

		expect(globSync("**/*.spec.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.spec.ts",
		]);

		expect(readdir).toHaveBeenCalledTimes(afterFirst);
	});

	it("should walk again for each call when no cache is given", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/app.ts": "" }, CWD);
		const readdir = vi.spyOn(fileSystem, "readdirSync");

		expect(globSync("**/*.ts", { cwd: CWD, fileSystem })).toStrictEqual(["src/app.ts"]);

		const afterFirst = readdir.mock.calls.length;

		globSync("**/*.ts", { cwd: CWD, fileSystem });

		expect(readdir.mock.calls.length).toBeGreaterThan(afterFirst);
	});

	it("should key a shared cache by cwd", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "a.ts": "" }, "/one");
		volume.fromJSON({ "b.ts": "" }, "/two");
		const cache = createGlobCache();

		expect(globSync("*.ts", { cache, cwd: "/one", fileSystem })).toStrictEqual(["a.ts"]);
		expect(globSync("*.ts", { cache, cwd: "/two", fileSystem })).toStrictEqual(["b.ts"]);
	});

	it("should not let the first pattern narrow an undeclared shared cache", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/app.luau": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache();

		expect(globSync("**/*.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual(["src/app.ts"]);
		// The cache was declared for nothing, so its walk keeps everything —
		// filtering it by the first pattern's leaf would answer this short.
		expect(globSync("**/*.luau", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.luau",
		]);
	});

	it("should still walk once when a declared cache serves several patterns", () => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/app.spec.luau": "", "src/app.spec.ts": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache(["**/*.spec.ts", "**/*.spec.luau"]);
		const readdir = vi.spyOn(fileSystem, "readdirSync");

		expect(globSync("**/*.spec.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.spec.ts",
		]);

		const afterFirst = readdir.mock.calls.length;

		expect(globSync("**/*.spec.luau", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.spec.luau",
		]);

		expect(readdir).toHaveBeenCalledTimes(afterFirst);
	});

	it("should serve a pattern the cache was not declared for without losing files", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/app.spec.ts": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache(["**/*.spec.ts"]);

		expect(globSync("**/*.spec.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.spec.ts",
		]);
		expect(globSync("**/*.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/app.spec.ts",
			"src/app.ts",
		]);
	});
});

describe("walk filtering", () => {
	it("should not retain files no declared pattern can match", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "out/bundle.js": "", "pkg/package.json": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache(["*/package.json"]);

		expect(globSync("*/package.json", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"pkg/package.json",
		]);
		// The walk keeps only what a declared pattern can match, so the cached
		// array grows with the packages rather than with the whole checkout.
		expect(cache.walks.get(CWD)).toStrictEqual(["pkg/package.json"]);
	});

	it("should retain everything when a declared pattern ends in a doublestar", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "out/bundle.js": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache(["src/**"]);

		expect(globSync("src/**", { cache, cwd: CWD, fileSystem })).toStrictEqual(["src/app.ts"]);
		expect(cache.walks.get(CWD)).toStrictEqual(["out/bundle.js", "src/app.ts"]);
	});

	it("should retain the union across declared patterns", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "a.luau": "", "a.ts": "", "a.txt": "" }, CWD);
		const cache = createGlobCache(["*.ts", "*.luau"]);
		globSync("*.ts", { cache, cwd: CWD, fileSystem });

		expect(cache.walks.get(CWD)).toStrictEqual(["a.luau", "a.ts"]);
	});

	it("should filter an uncached call by its own trailing segment", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "a/package.json": "", "a/tsconfig.json": "" }, CWD);

		expect(globSync("*/package.json", { cwd: CWD, fileSystem })).toStrictEqual([
			"a/package.json",
		]);
	});
});

describe("leaf derivation", () => {
	it("should drop the filter when any declared pattern is unconstrained", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "a.ts": "", "b.txt": "" }, CWD);
		// One `**` tail among several patterns widens the walk to everything,
		// because the walk keeps the union of what the patterns match.
		const cache = createGlobCache(["*.ts", "src/**"]);
		globSync("*.ts", { cache, cwd: CWD, fileSystem });

		expect(cache.walks.get(CWD)).toStrictEqual(["a.ts", "b.txt"]);
	});

	it("should not serve an unconstrained pattern from a declared cache", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "src/a.ts": "", "src/b.txt": "" }, CWD);
		const cache = createGlobCache(["*.ts"]);

		expect(globSync("**/*.ts", { cache, cwd: CWD, fileSystem })).toStrictEqual(["src/a.ts"]);
		// `src/**` constrains no basename, so reading the `*.ts` walk would
		// answer it short.
		expect(globSync("src/**", { cache, cwd: CWD, fileSystem })).toStrictEqual([
			"src/a.ts",
			"src/b.txt",
		]);
	});

	it("should treat a pattern with no separator as its own leaf", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.fromJSON({ "package.json": "", "tsconfig.json": "" }, CWD);

		expect(globSync("package.json", { cwd: CWD, fileSystem })).toStrictEqual(["package.json"]);
	});
});

describe("doublestar expansion", () => {
	it("should match any depth below a trailing doublestar", () => {
		expect.assertions(3);

		expect(matchesGlobPattern("tools/a/b", "tools/**")).toBeTrue();
		expect(matchesGlobPattern("tools/a", "tools/**")).toBeTrue();
		expect(matchesGlobPattern("other/a/b", "tools/**")).toBeFalse();
	});

	it("should match any depth on both sides of an interior segment", () => {
		expect.assertions(2);

		expect(matchesGlobPattern("x/fixtures/y/z", "**/fixtures/**")).toBeTrue();
		expect(matchesGlobPattern("x/other/y/z", "**/fixtures/**")).toBeFalse();
	});

	it("should keep a single star inside one segment", () => {
		expect.assertions(2);

		expect(matchesGlobPattern("tools/ab", "tools/*")).toBeTrue();
		expect(matchesGlobPattern("tools/a/b", "tools/*")).toBeFalse();
	});
});
