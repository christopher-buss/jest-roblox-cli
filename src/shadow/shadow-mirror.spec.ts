import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { syncNonInstrumentedFiles, syncOneFile } from "./shadow-mirror.ts";

describe(syncOneFile, () => {
	it("should overwrite a stale target when a matching record names another path", () => {
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
	it("should leave coverage-map sidecars out of the mirrored files", () => {
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
});
