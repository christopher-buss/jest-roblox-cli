import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "./memory-file-system.ts";

describe(createMemoryFileSystem, () => {
	// A seed key without a leading slash is relative, and memfs resolves a
	// relative lookup against `process.cwd()` however the volume was seeded. A
	// volume seeded from a different base answers `false` to a path it was
	// handed verbatim.
	//
	// Windows hides this: memfs strips the drive from `C:/foo`, so a fixture
	// written that way is absolute there and relative everywhere else. The
	// `studio-discovery` fixtures are exactly that shape, which is why the gap
	// only ever surfaced on a Linux runner.
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
