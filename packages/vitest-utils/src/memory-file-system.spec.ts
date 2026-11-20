import path from "node:path";
import { describe, it } from "vitest";

import { createMemoryFileSystem } from "./memory-file-system.ts";

describe(createMemoryFileSystem, () => {
	it("should serve the seed files through the file system", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "/root/a.txt": "alpha" });

		expect(fileSystem.readFileSync("/root/a.txt", "utf8")).toBe("alpha");
	});

	it("should share one volume between the file system and the volume handle", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync("/root", { recursive: true });
		volume.writeFileSync("/root/b.txt", "beta");

		expect(fileSystem.readFileSync("/root/b.txt", "utf8")).toBe("beta");
	});

	it("should resolve relative seed paths against the given directory", ({ expect }) => {
		expect.assertions(1);

		const cwd = path.resolve("/project");
		const { fileSystem } = createMemoryFileSystem({ "c.txt": "gamma" }, cwd);

		expect(fileSystem.readFileSync(path.join(cwd, "c.txt"), "utf8")).toBe("gamma");
	});

	it("should resolve relative seed paths against the process directory by default", ({
		expect,
	}) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({ "d.txt": "delta" });

		expect(fileSystem.existsSync(path.resolve("d.txt"))).toBeTrue();
	});
});
