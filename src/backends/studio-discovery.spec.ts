// cspell:ignore LOCALAPPDATA mtime mtimes
import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import { discoverStudioPath } from "./studio-discovery.ts";

const WIN_ENV = { LOCALAPPDATA: "C:/Users/dev/AppData/Local" };

/**
 * A volume holding the installs the probe should find.
 *
 * @param files - The executables on disk.
 */
function seed(files: Record<string, string> = {}): MemoryFileSystem {
	return createMemoryFileSystem(files);
}

function versionExe(version: string): string {
	return `C:/Users/dev/AppData/Local/Roblox/Versions/${version}/RobloxStudioBeta.exe`;
}

describe(discoverStudioPath, () => {
	it("should return the override when the file exists", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ "C:/custom/RobloxStudioBeta.exe": "binary" });

		expect(discoverStudioPath({ fileSystem, override: "C:/custom/RobloxStudioBeta.exe" })).toBe(
			"C:/custom/RobloxStudioBeta.exe",
		);
	});

	it("should throw a clear error when the override does not exist", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(() => {
			return discoverStudioPath({ fileSystem, override: "C:/missing/RobloxStudioBeta.exe" });
		}).toThrow(/studioPath override: C:\/missing\/RobloxStudioBeta\.exe/);
	});

	it("should throw when the override points at a directory, not a file", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ "C:/studio-dir/placeholder": "x" });

		expect(() => discoverStudioPath({ fileSystem, override: "C:/studio-dir" })).toThrow(
			/studioPath override is not a file/,
		);
	});

	it("should find RobloxStudioBeta.exe under the Windows Versions directory", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [versionExe("version-abc")]: "binary" });

		expect(discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" })).toBe(
			versionExe("version-abc"),
		);
	});

	it("should pick the newest Studio executable by mtime across versions", () => {
		expect.assertions(1);

		// readdir returns entries alphabetically. The mtimes are arranged so the
		// scan first sets a baseline (version-1), then updates to a newer one
		// (version-2), then sees an older one it must reject (version-3).
		const { fileSystem, volume } = seed({
			[versionExe("version-1")]: "mid",
			[versionExe("version-2")]: "new",
			[versionExe("version-3")]: "old",
		});
		volume.utimesSync(versionExe("version-1"), new Date(5000), new Date(5000));
		volume.utimesSync(versionExe("version-2"), new Date(9000), new Date(9000));
		volume.utimesSync(versionExe("version-3"), new Date(1000), new Date(1000));

		expect(discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" })).toBe(
			versionExe("version-2"),
		);
	});

	it("should keep the first Studio executable when mtimes are equal", () => {
		expect.assertions(1);

		const { fileSystem, volume } = seed({
			[versionExe("version-1")]: "first",
			[versionExe("version-2")]: "second",
		});
		volume.utimesSync(versionExe("version-1"), new Date(5000), new Date(5000));
		volume.utimesSync(versionExe("version-2"), new Date(5000), new Date(5000));

		expect(discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" })).toBe(
			versionExe("version-1"),
		);
	});

	it("should skip version entries that are files and those missing the executable", () => {
		expect.assertions(2);

		const { fileSystem } = seed({
			"C:/Users/dev/AppData/Local/Roblox/Versions/loose-file": "not-a-dir",
			"C:/Users/dev/AppData/Local/Roblox/Versions/version-empty/other.dll": "x",
			[versionExe("version-real")]: "binary",
		});
		const stat = vi.spyOn(fileSystem, "statSync");

		expect(discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" })).toBe(
			versionExe("version-real"),
		);
		expect(stat).not.toHaveBeenCalledWith(expect.stringContaining("loose-file"), {
			throwIfNoEntry: false,
		});
	});

	it("should throw a not-found error when no Studio executable exists on Windows", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			"C:/Users/dev/AppData/Local/Roblox/Versions/version-empty/x.dll": "x",
		});

		expect(() => {
			return discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" });
		}).toThrow(/Roblox Studio not found/);
	});

	it("should throw a not-found error when the Versions directory is absent", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(() => {
			return discoverStudioPath({ environment: WIN_ENV, fileSystem, platform: "win32" });
		}).toThrow(
			new Error(
				"Roblox Studio not found. Install Roblox Studio, or set studioPath " +
					"(config key, --studioPath, or JEST_ROBLOX_STUDIO_PATH).",
			),
		);
	});

	it("should throw when LOCALAPPDATA is not set on Windows", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(() => {
			return discoverStudioPath({ environment: {}, fileSystem, platform: "win32" });
		}).toThrow(/LOCALAPPDATA is not set/);
	});

	it("should throw when LOCALAPPDATA is empty on Windows", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(() => {
			discoverStudioPath({
				environment: { LOCALAPPDATA: "" },
				fileSystem,
				platform: "win32",
			});
		}).toThrow(/LOCALAPPDATA is not set/);
	});

	it("should return the macOS app-bundle executable when present", () => {
		expect.assertions(1);

		const { fileSystem } = seed({
			"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta": "binary",
		});

		expect(discoverStudioPath({ fileSystem, platform: "darwin" })).toBe(
			"/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudioBeta",
		);
	});

	it("should throw a not-found error when Studio is absent on macOS", () => {
		expect.assertions(1);

		const { fileSystem } = seed();

		expect(() => discoverStudioPath({ fileSystem, platform: "darwin" })).toThrow(
			/Roblox Studio not found/,
		);
	});

	it("should throw an unsupported-platform error on Linux", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(() => discoverStudioPath({ fileSystem, platform: "linux" })).toThrow(
			new Error(
				'studio-cli backend has no Studio auto-discovery for platform "linux". ' +
					"Set studioPath to point at your Roblox Studio executable.",
			),
		);
	});
});
