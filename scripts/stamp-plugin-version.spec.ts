import { describe, expect, it } from "vitest";

import type { MemoryFileSystem } from "../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../test/mocks/memory-file-system.ts";
import { stampPluginVersion } from "./stamp-plugin-version.ts";

/**
 * A volume holding a package whose plugin is waiting for its stamp.
 *
 * @param version - What the package manifest declares.
 */
function seed(version: string): MemoryFileSystem {
	return createMemoryFileSystem({
		"/pkg/package.json": JSON.stringify({ name: "@isentinel/jest-roblox", version }),
		"/pkg/plugin/src/init.server.luau": "",
	});
}

describe(stampPluginVersion, () => {
	it("should write the package version as a Luau module", () => {
		expect.assertions(2);

		const { fileSystem, volume } = seed("1.2.3");

		expect(stampPluginVersion("/pkg", fileSystem)).toBe("1.2.3");
		expect(volume.readFileSync("/pkg/plugin/src/version.luau", "utf8")).toContain(
			'return "1.2.3"',
		);
	});

	it("should overwrite a stamp left by an earlier build", () => {
		// The file is generated, never merged: a rebuild after a version bump
		// has to replace it, or the plugin reports the release before last.
		expect.assertions(1);

		const { fileSystem, volume } = seed("2.0.0");
		volume.writeFileSync("/pkg/plugin/src/version.luau", 'return "0.0.1"');

		stampPluginVersion("/pkg", fileSystem);

		expect(volume.readFileSync("/pkg/plugin/src/version.luau", "utf8")).not.toContain("0.0.1");
	});
});
