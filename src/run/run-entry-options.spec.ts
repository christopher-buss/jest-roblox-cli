import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import { describe, it, vi } from "vitest";

import { readTimingSetting, settleRunEntry } from "./run-entry-options.ts";

describe(readTimingSetting, () => {
	it("should enable timing only when TIMING is set", ({ expect }) => {
		expect.assertions(2);

		vi.stubEnv("TIMING", undefined);

		expect(readTimingSetting()).toBeFalse();

		vi.stubEnv("TIMING", "");

		expect(readTimingSetting()).toBeTrue();
	});
});

describe(settleRunEntry, () => {
	it("should keep the caller's file system", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(settleRunEntry({ fileSystem }).fileSystem).toBe(fileSystem);
	});
});
