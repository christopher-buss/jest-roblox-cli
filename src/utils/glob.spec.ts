import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { globSync } from "./glob.ts";

vi.mock(import("node:fs"));

interface DirentLike {
	name: string;
	isDirectory: () => boolean;
}

function file(name: string): DirentLike {
	return { name, isDirectory: () => false };
}

function directory(name: string): DirentLike {
	return { name, isDirectory: () => true };
}

describe(globSync, () => {
	const cwd = "/project";

	it("should return empty array for empty directory", () => {
		expect.assertions(1);

		vi.mocked(fs.readdirSync).mockReturnValue([]);

		expect(globSync("**/*.ts", { cwd })).toBeEmpty();

		vi.restoreAllMocks();
	});

	it("should match files with single wildcard pattern", () => {
		expect.assertions(1);

		vi.mocked(fs.readdirSync).mockReturnValue([
			file("app.ts"),
			file("util.ts"),
			file("readme.md"),
		] as unknown as ReturnType<typeof fs.readdirSync>);

		const result = globSync("*.ts", { cwd });

		expect(result).toStrictEqual(["app.ts", "util.ts"]);

		vi.restoreAllMocks();
	});

	it("should match files recursively with double-star pattern", () => {
		expect.assertions(3);

		const sourceDirectory = path.join(cwd, "src");
		vi.mocked(fs.readdirSync).mockImplementation((directoryPath) => {
			if (String(directoryPath) === cwd) {
				return [directory("src"), file("root.ts")] as unknown as ReturnType<
					typeof fs.readdirSync
				>;
			}

			if (String(directoryPath) === sourceDirectory) {
				return [file("index.ts"), file("util.js")] as unknown as ReturnType<
					typeof fs.readdirSync
				>;
			}

			return [] as unknown as ReturnType<typeof fs.readdirSync>;
		});

		const result = globSync("**/*.ts", { cwd });

		// **/ matches zero or more path segments (standard glob semantics)
		expect(result).toContain("root.ts");
		expect(result).toContain("src/index.ts");
		expect(result).not.toContain("src/util.js");

		vi.restoreAllMocks();
	});

	it("should skip node_modules directories", () => {
		expect.assertions(1);

		const sourceDirectory = path.join(cwd, "src");
		vi.mocked(fs.readdirSync).mockImplementation((directoryPath) => {
			const directoryPathStr = String(directoryPath);
			if (directoryPathStr === cwd) {
				return [directory("node_modules"), directory("src")] as unknown as ReturnType<
					typeof fs.readdirSync
				>;
			}

			if (directoryPathStr === sourceDirectory) {
				return [file("app.ts")] as unknown as ReturnType<typeof fs.readdirSync>;
			}

			if (directoryPathStr.includes("node_modules")) {
				throw new Error("Should not read node_modules");
			}

			return [] as unknown as ReturnType<typeof fs.readdirSync>;
		});

		const result = globSync("**/*.ts", { cwd });

		expect(result).toStrictEqual(["src/app.ts"]);

		vi.restoreAllMocks();
	});

	it("should skip dot directories", () => {
		expect.assertions(1);

		const sourceDirectory = path.join(cwd, "src");
		vi.mocked(fs.readdirSync).mockImplementation((directoryPath) => {
			const directoryPathStr = String(directoryPath);
			if (directoryPathStr === cwd) {
				return [directory(".git"), directory("src")] as unknown as ReturnType<
					typeof fs.readdirSync
				>;
			}

			if (directoryPathStr === sourceDirectory) {
				return [file("app.ts")] as unknown as ReturnType<typeof fs.readdirSync>;
			}

			if (directoryPathStr.includes(".git")) {
				throw new Error("Should not read .git");
			}

			return [] as unknown as ReturnType<typeof fs.readdirSync>;
		});

		const result = globSync("**/*.ts", { cwd });

		expect(result).toStrictEqual(["src/app.ts"]);

		vi.restoreAllMocks();
	});

	it("should match files directly in a prefixed doublestar directory", () => {
		expect.assertions(1);

		const sourceDirectory = path.join(cwd, "src");
		vi.mocked(fs.readdirSync).mockImplementation((directoryPath) => {
			if (String(directoryPath) === cwd) {
				return [directory("src")] as unknown as ReturnType<typeof fs.readdirSync>;
			}

			if (String(directoryPath) === sourceDirectory) {
				return [file("init.spec.luau")] as unknown as ReturnType<typeof fs.readdirSync>;
			}

			return [] as unknown as ReturnType<typeof fs.readdirSync>;
		});

		const result = globSync("src/**/*.spec.luau", { cwd });

		expect(result).toStrictEqual(["src/init.spec.luau"]);

		vi.restoreAllMocks();
	});

	it("should handle permission errors gracefully", () => {
		expect.assertions(1);

		vi.mocked(fs.readdirSync).mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		const result = globSync("**/*.ts", { cwd });

		expect(result).toBeEmpty();

		vi.restoreAllMocks();
	});

	it("should default cwd to process.cwd() when not provided", () => {
		expect.assertions(1);

		const processCwd = process.cwd();
		vi.mocked(fs.readdirSync).mockReturnValue([file("index.ts")] as unknown as ReturnType<
			typeof fs.readdirSync
		>);

		globSync("*");

		expect(vi.mocked(fs.readdirSync)).toHaveBeenCalledWith(processCwd, {
			withFileTypes: true,
		});

		vi.restoreAllMocks();
	});

	it("should match dot-extension patterns correctly", () => {
		expect.assertions(1);

		vi.mocked(fs.readdirSync).mockReturnValue([
			file("test.spec.ts"),
			file("test.ts"),
		] as unknown as ReturnType<typeof fs.readdirSync>);

		const result = globSync("*.spec.ts", { cwd });

		expect(result).toStrictEqual(["test.spec.ts"]);

		vi.restoreAllMocks();
	});
});
