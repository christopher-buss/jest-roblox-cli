// cspell:ignore LOCALAPPDATA mtime mtimes
import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { discoverStudioPath } from "./studio-discovery.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const WIN_ENV = { LOCALAPPDATA: "C:/Users/dev/AppData/Local" };

function seed(files: Record<string, string> = {}): void {
	vol.reset();
	vol.fromJSON(files);
}

function versionExe(version: string): string {
	return `C:/Users/dev/AppData/Local/Roblox/Versions/${version}/RobloxStudioBeta.exe`;
}

describe(discoverStudioPath, () => {
	it("should return the override when the file exists", () => {
		expect.assertions(1);

		seed({ "C:/custom/RobloxStudioBeta.exe": "binary" });

		expect(discoverStudioPath({ override: "C:/custom/RobloxStudioBeta.exe" })).toBe(
			"C:/custom/RobloxStudioBeta.exe",
		);
	});

	it("should throw a clear error when the override does not exist", () => {
		expect.assertions(1);

		seed();

		expect(() => discoverStudioPath({ override: "C:/missing/RobloxStudioBeta.exe" })).toThrow(
			/studioPath override: C:\/missing\/RobloxStudioBeta\.exe/,
		);
	});

	it("should throw when the override points at a directory, not a file", () => {
		expect.assertions(1);

		seed({ "C:/studio-dir/placeholder": "x" });

		expect(() => discoverStudioPath({ override: "C:/studio-dir" })).toThrow(
			/studioPath override is not a file/,
		);
	});

	it("should find RobloxStudioBeta.exe under the Windows Versions directory", () => {
		expect.assertions(1);

		seed({ [versionExe("version-abc")]: "binary" });

		expect(discoverStudioPath({ environment: WIN_ENV, platform: "win32" })).toBe(
			versionExe("version-abc"),
		);
	});

	it("should pick the newest Studio executable by mtime across versions", () => {
		expect.assertions(1);

		// readdir returns entries alphabetically. The mtimes are arranged so the
		// scan first sets a baseline (version-1), then updates to a newer one
		// (version-2), then sees an older one it must reject (version-3).
		seed({
			[versionExe("version-1")]: "mid",
			[versionExe("version-2")]: "new",
			[versionExe("version-3")]: "old",
		});
		fs.utimesSync(versionExe("version-1"), new Date(5000), new Date(5000));
		fs.utimesSync(versionExe("version-2"), new Date(9000), new Date(9000));
		fs.utimesSync(versionExe("version-3"), new Date(1000), new Date(1000));

		expect(discoverStudioPath({ environment: WIN_ENV, platform: "win32" })).toBe(
			versionExe("version-2"),
		);
	});

	it("should skip version entries that are files and those missing the executable", () => {
		expect.assertions(1);

		seed({
			"C:/Users/dev/AppData/Local/Roblox/Versions/loose-file": "not-a-dir",
			"C:/Users/dev/AppData/Local/Roblox/Versions/version-empty/other.dll": "x",
			[versionExe("version-real")]: "binary",
		});

		expect(discoverStudioPath({ environment: WIN_ENV, platform: "win32" })).toBe(
			versionExe("version-real"),
		);
	});

	it("should throw a not-found error when no Studio executable exists on Windows", () => {
		expect.assertions(1);

		seed({ "C:/Users/dev/AppData/Local/Roblox/Versions/version-empty/x.dll": "x" });

		expect(() => discoverStudioPath({ environment: WIN_ENV, platform: "win32" })).toThrow(
			/Roblox Studio not found/,
		);
	});

	it("should throw a not-found error when the Versions directory is absent", () => {
		expect.assertions(1);

		seed();

		expect(() => discoverStudioPath({ environment: WIN_ENV, platform: "win32" })).toThrow(
			/Roblox Studio not found/,
		);
	});

	it("should throw when LOCALAPPDATA is not set on Windows", () => {
		expect.assertions(1);

		seed();

		expect(() => discoverStudioPath({ environment: {}, platform: "win32" })).toThrow(
			/LOCALAPPDATA is not set/,
		);
	});

	it("should return the macOS app-bundle executable when present", () => {
		expect.assertions(1);

		seed({ "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta": "binary" });

		expect(discoverStudioPath({ platform: "darwin" })).toBe(
			"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta",
		);
	});

	it("should throw a not-found error when Studio is absent on macOS", () => {
		expect.assertions(1);

		seed();

		expect(() => discoverStudioPath({ platform: "darwin" })).toThrow(/Roblox Studio not found/);
	});

	it("should throw an unsupported-platform error on Linux", () => {
		expect.assertions(1);

		expect(() => discoverStudioPath({ platform: "linux" })).toThrow(
			/no Studio auto-discovery for platform "linux"/,
		);
	});
});
