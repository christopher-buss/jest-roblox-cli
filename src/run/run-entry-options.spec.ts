import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { readTimingSetting, settleRunEntry } from "./run-entry-options.ts";

describe(readTimingSetting, () => {
	it("should enable timing only when TIMING is set", () => {
		expect.assertions(2);

		vi.stubEnv("TIMING", undefined);

		expect(readTimingSetting()).toBeFalse();

		vi.stubEnv("TIMING", "");

		expect(readTimingSetting()).toBeTrue();
	});
});

describe(settleRunEntry, () => {
	it("should keep the caller's file system", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(settleRunEntry({ fileSystem }).fileSystem).toBe(fileSystem);
	});
});
