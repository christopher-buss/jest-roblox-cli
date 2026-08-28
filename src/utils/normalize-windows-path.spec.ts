import { describe, expect, it } from "vitest";

import {
	dropDriveLetter,
	isAbsolutePath,
	normalizeWindowsPath,
	toPosixRoot,
} from "./normalize-windows-path.ts";

describe(dropDriveLetter, () => {
	it("should only drop a drive letter at the start", () => {
		expect.assertions(2);

		expect(dropDriveLetter("D:/repo/file.ts")).toBe("/repo/file.ts");
		expect(dropDriveLetter("prefix/D:/repo/file.ts")).toBe("prefix/D:/repo/file.ts");
	});
});

describe(isAbsolutePath, () => {
	it("should only recognize drive roots at the start", () => {
		expect.assertions(3);

		expect(isAbsolutePath("D:/repo/file.ts")).toBeTrue();
		expect(isAbsolutePath("/repo/file.ts")).toBeTrue();
		expect(isAbsolutePath("prefix/D:/repo/file.ts")).toBeFalse();
	});
});

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

describe(toPosixRoot, () => {
	it("should remove a trailing separator", () => {
		expect.assertions(1);

		expect(toPosixRoot("out/")).toBe("out");
	});

	it("should remove a leading current-directory prefix", () => {
		expect.assertions(2);

		expect(toPosixRoot("./out")).toBe("out");
		expect(toPosixRoot(".\\out")).toBe("out");
	});

	it("should remove a current-directory segment at the start only", () => {
		expect.assertions(1);

		expect(toPosixRoot("out/./nested")).toBe("out/./nested");
	});
});
