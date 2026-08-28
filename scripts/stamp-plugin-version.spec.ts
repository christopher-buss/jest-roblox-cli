import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { stampPluginVersion } from "./stamp-plugin-version.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

function seed(version: string): string {
	vol.reset();
	onTestFinished(() => {
		vol.reset();
	});
	vol.fromJSON({
		"/pkg/package.json": JSON.stringify({ name: "@isentinel/jest-roblox", version }),
		"/pkg/plugin/src/init.server.luau": "",
	});
	return "/pkg";
}

describe(stampPluginVersion, () => {
	it("should write the package version as a Luau module", () => {
		expect.assertions(2);

		const root = seed("1.2.3");

		expect(stampPluginVersion(root)).toBe("1.2.3");
		expect(vol.readFileSync("/pkg/plugin/src/version.luau", "utf8")).toContain(
			'return "1.2.3"',
		);
	});

	it("should overwrite a stamp left by an earlier build", () => {
		// The file is generated, never merged: a rebuild after a version bump
		// has to replace it, or the plugin reports the release before last.
		expect.assertions(1);

		const root = seed("2.0.0");
		vol.writeFileSync("/pkg/plugin/src/version.luau", 'return "0.0.1"');

		stampPluginVersion(root);

		expect(vol.readFileSync("/pkg/plugin/src/version.luau", "utf8")).not.toContain("0.0.1");
	});
});
