import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createGlobCache, globSync, matchesGlobPattern } from "./glob.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const CWD = "/project";

describe(globSync, () => {
	it("should return empty array for empty directory", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.mkdirSync(CWD, { recursive: true });

		expect(globSync("**/*.ts", { cwd: CWD })).toBeEmpty();
	});

	it("should match files with single wildcard pattern", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "app.ts": "", "readme.md": "", "util.ts": "" }, CWD);

		expect(globSync("*.ts", { cwd: CWD })).toStrictEqual(["app.ts", "util.ts"]);
	});

	it("should match files recursively with double-star pattern", () => {
		expect.assertions(3);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "root.ts": "", "src/index.ts": "", "src/util.js": "" }, CWD);

		const result = globSync("**/*.ts", { cwd: CWD });

		// **/ matches zero or more path segments (standard glob semantics)
		expect(result).toContain("root.ts");
		expect(result).toContain("src/index.ts");
		expect(result).not.toContain("src/util.js");
	});

	it("should skip node_modules directories", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "node_modules/dep/index.ts": "", "src/app.ts": "" }, CWD);

		expect(globSync("**/*.ts", { cwd: CWD })).toStrictEqual(["src/app.ts"]);
	});

	it("should skip dot directories", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ ".git/hooks/pre-commit.ts": "", "src/app.ts": "" }, CWD);

		expect(globSync("**/*.ts", { cwd: CWD })).toStrictEqual(["src/app.ts"]);
	});

	it("should match files directly in a prefixed doublestar directory", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "src/init.spec.luau": "" }, CWD);

		expect(globSync("src/**/*.spec.luau", { cwd: CWD })).toStrictEqual(["src/init.spec.luau"]);
	});

	it("should handle permission errors gracefully", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "app.ts": "" }, CWD);
		vi.spyOn(fs, "readdirSync").mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		expect(globSync("**/*.ts", { cwd: CWD })).toBeEmpty();
	});

	it("should default cwd to process.cwd() when not provided", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vi.spyOn(process, "cwd").mockReturnValue("/default-cwd");
		vol.fromJSON({ "index.ts": "" }, "/default-cwd");

		expect(globSync("*")).toStrictEqual(["index.ts"]);
	});

	it("should match root files through a leading ./ in the pattern", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "package.json": "", "src/package.json": "" }, CWD);

		expect(globSync("./package.json", { cwd: CWD })).toStrictEqual(["package.json"]);
	});

	it("should match dot-extension patterns correctly", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "test.spec.ts": "", "test.ts": "" }, CWD);

		expect(globSync("*.spec.ts", { cwd: CWD })).toStrictEqual(["test.spec.ts"]);
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

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "src/app.spec.ts": "", "src/app.ts": "" }, CWD);
		const cache = createGlobCache();
		const readdir = vi.spyOn(fs, "readdirSync");

		expect(globSync("**/*.ts", { cache, cwd: CWD })).toHaveLength(2);

		const afterFirst = readdir.mock.calls.length;

		expect(globSync("**/*.spec.ts", { cache, cwd: CWD })).toStrictEqual(["src/app.spec.ts"]);

		expect(readdir).toHaveBeenCalledTimes(afterFirst);
	});

	it("should walk again for each call when no cache is given", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "src/app.ts": "" }, CWD);
		const readdir = vi.spyOn(fs, "readdirSync");

		expect(globSync("**/*.ts", { cwd: CWD })).toStrictEqual(["src/app.ts"]);

		const afterFirst = readdir.mock.calls.length;

		globSync("**/*.ts", { cwd: CWD });

		expect(readdir.mock.calls.length).toBeGreaterThan(afterFirst);
	});

	it("should key a shared cache by cwd", () => {
		expect.assertions(2);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "a.ts": "" }, "/one");
		vol.fromJSON({ "b.ts": "" }, "/two");
		const cache = createGlobCache();

		expect(globSync("*.ts", { cache, cwd: "/one" })).toStrictEqual(["a.ts"]);
		expect(globSync("*.ts", { cache, cwd: "/two" })).toStrictEqual(["b.ts"]);
	});
});
