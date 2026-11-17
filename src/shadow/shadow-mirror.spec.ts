import { describe, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { syncNonInstrumentedFiles, syncOneFile } from "./shadow-mirror.ts";

describe(syncOneFile, () => {
	it("should overwrite a stale target when a matching record names another path", ({
		expect,
	}) => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/source.luau": "return 'current'\n",
			"/target.luau": "return 'stale'\n",
		});
		const previousRecord = syncOneFile({
			fileSystem,
			previousRecord: undefined,
			shadowPath: "/previous.luau",
			sourcePath: "/source.luau",
		});

		const record = syncOneFile({
			fileSystem,
			previousRecord,
			shadowPath: "/target.luau",
			sourcePath: "/source.luau",
		});

		expect(record.shadowPath).toBe("/target.luau");
		expect(volume.readFileSync("/target.luau", "utf8")).toBe("return 'current'\n");
	});
});

describe(syncNonInstrumentedFiles, () => {
	it("should leave coverage-map sidecars out of the mirrored files", ({ expect }) => {
		expect.assertions(3);

		const { fileSystem, volume } = createMemoryFileSystem({
			"/source/data.json": "payload",
			"/source/module.cov-map.json": "{}",
		});
		const result = syncNonInstrumentedFiles({
			excluded: new Set(),
			fileSystem,
			isCopyIgnored: () => false,
			luauRoot: posixRoot("/source"),
			previousNonInstrumented: undefined,
			shadowDir: "/shadow",
		});

		expect(volume.existsSync("/shadow/module.cov-map.json")).toBeFalse();
		expect(volume.readFileSync("/shadow/data.json", "utf8")).toBe("payload");
		expect(Object.keys(result.files)).toStrictEqual(["/source/data.json"]);
	});

	describe("changed", () => {
		function sync(
			fileSystem: ReturnType<typeof createMemoryFileSystem>["fileSystem"],
			previousNonInstrumented?: ReturnType<typeof syncNonInstrumentedFiles>["files"],
		): ReturnType<typeof syncNonInstrumentedFiles> {
			return syncNonInstrumentedFiles({
				excluded: new Set(),
				fileSystem,
				isCopyIgnored: () => false,
				luauRoot: posixRoot("/source"),
				previousNonInstrumented,
				shadowDir: "/shadow",
			});
		}

		it("should be false when the shadow already matches the source", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem } = createMemoryFileSystem({ "/source/lib/data.json": "payload" });
			const first = sync(fileSystem);

			expect(sync(fileSystem, first.files).changed).toBeFalse();
		});

		it("should be true when a file changes under existing shadow directories", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem({
				"/source/lib/data.json": "payload",
			});
			const first = sync(fileSystem);
			volume.writeFileSync("/source/lib/data.json", "edited");

			expect(sync(fileSystem, first.files).changed).toBeTrue();
		});

		it("should be true when only a new empty directory appears", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem({
				"/source/lib/data.json": "payload",
			});
			const first = sync(fileSystem);
			volume.mkdirSync("/source/empty");

			expect(sync(fileSystem, first.files).changed).toBeTrue();
		});
	});
});
