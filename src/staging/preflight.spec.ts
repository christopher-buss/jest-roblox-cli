import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { runProjectPreflight } from "./preflight.ts";

describe(runProjectPreflight, () => {
	it("should report an undiscovered project at the default path", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();
		const chunks: Array<string> = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});
		const rootDirectory = path.resolve("/pkg");
		const isReady = runProjectPreflight(
			createResolvedConfig({ rojoProject: undefined, rootDir: rootDirectory }),
			fileSystem,
		);

		expect(isReady).toBeFalse();
		expect(chunks.join("")).toBe(
			"Pre-flight validation failed:\n  pkg: rojoProject not found at default.project.json\n",
		);
	});
});
