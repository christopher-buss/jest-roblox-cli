import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { syncOneFile } from "./shadow-mirror.ts";

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
