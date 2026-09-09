import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { clearDirectoryAtFilePath, createShadowDirectory } from "./shadow-entry.ts";

describe(createShadowDirectory, () => {
	it("should create an absent directory without attempting to remove it", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const remove = vi.spyOn(fileSystem, "rmSync");

		expect(createShadowDirectory("/shadow", fileSystem)).toBeTrue();
		expect(remove).not.toHaveBeenCalled();
	});

	it("should tolerate a file disappearing after its type is read", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/shadow/init": "return 'old'\n",
		});
		vi.spyOn(fileSystem, "statSync").mockImplementation(() => {
			const existing = volume.statSync("/shadow/init");
			volume.unlinkSync("/shadow/init");
			return existing;
		});

		expect(createShadowDirectory("/shadow/init", fileSystem)).toBeTrue();
		expect(volume.statSync("/shadow/init").isDirectory()).toBeTrue();
	});
});

describe(clearDirectoryAtFilePath, () => {
	it("should preserve a file already at the path", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/shadow/init.luau": "return 'current'\n",
		});

		clearDirectoryAtFilePath("/shadow/init.luau", fileSystem);

		expect(volume.readFileSync("/shadow/init.luau", "utf-8")).toBe("return 'current'\n");
	});

	it("should tolerate a directory disappearing after its type is read", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/shadow/init/child.luau": "return 'old'\n",
		});
		vi.spyOn(fileSystem, "statSync").mockImplementation(() => {
			const existing = volume.statSync("/shadow/init");
			volume.rmSync("/shadow/init", { recursive: true });
			return existing;
		});

		expect(() => {
			clearDirectoryAtFilePath("/shadow/init", fileSystem);
		}).not.toThrow();
	});
});
