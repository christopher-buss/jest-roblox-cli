import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { globSync } from "./glob.ts";

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

	it("should match dot-extension patterns correctly", () => {
		expect.assertions(1);

		onTestFinished(() => {
			vol.reset();
		});

		vol.fromJSON({ "test.spec.ts": "", "test.ts": "" }, CWD);

		expect(globSync("*.spec.ts", { cwd: CWD })).toStrictEqual(["test.spec.ts"]);
	});
});
