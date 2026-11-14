import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "./memory-file-system.ts";

describe(createMemoryFileSystem, () => {
	// memfs resolves a relative seed key against `process.cwd()`. Windows hides
	// this: memfs strips the drive from `C:/foo`, so the `studio-discovery`
	// fixtures are absolute there and relative elsewhere; the gap surfaced only
	// on Linux.
	it("should resolve a relative seed key the same way a relative read does", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({ "rel/file.txt": "x" });

		expect(fileSystem.existsSync("rel/file.txt")).toBeTrue();
		expect(fileSystem.readFileSync("rel/file.txt", "utf-8")).toBe("x");
	});

	it("should anchor a relative seed key to an explicit cwd when given one", () => {
		expect.assertions(1);

		const { volume } = createMemoryFileSystem({ "file.txt": "x" }, "/anchor");

		expect(volume.toJSON()).toHaveProperty("/anchor/file.txt");
	});

	it("should place an absolute seed key where it was written", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/abs/file.txt": "x" });

		expect(fileSystem.existsSync("/abs/file.txt")).toBeTrue();
	});
});
