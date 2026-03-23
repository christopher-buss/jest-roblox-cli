import { describe, expect, it } from "vitest";

import { normalizeWindowsPath } from "./normalize-windows-path.ts";

describe(normalizeWindowsPath, () => {
	it("should return empty string when called with no arguments", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath()).toBe("");
	});

	it("should return empty string for empty input", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("")).toBe("");
	});

	it("should convert backslashes to forward slashes", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("src\\utils\\file.ts")).toBe("src/utils/file.ts");
	});

	it("should uppercase the drive letter", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("c:/Users/foo")).toBe("C:/Users/foo");
	});

	it("should convert backslashes and uppercase drive letter together", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("d:\\roblox\\project")).toBe("D:/roblox/project");
	});

	it("should leave already-normalized paths unchanged", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("D:/roblox/project")).toBe("D:/roblox/project");
	});

	it("should only convert slashes for paths without drive letters", () => {
		expect.assertions(1);

		expect(normalizeWindowsPath("src\\components\\App.tsx")).toBe("src/components/App.tsx");
	});
});
