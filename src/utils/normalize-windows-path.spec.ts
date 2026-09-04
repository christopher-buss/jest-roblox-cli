import { describe, expect, it } from "vitest";

import {
	dropDriveLetter,
	isAbsolutePath,
	normalizeWindowsPath,
	relativeToRoot,
	toPosixRoot,
	underRoot,
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
	/** The canonical root as a plain string, so an assertion can name one. */
	function root(spelling: string): string {
		return toPosixRoot(spelling);
	}

	it("should remove a trailing separator", () => {
		expect.assertions(1);

		expect(root("out/")).toBe("out");
	});

	it("should remove a leading current-directory prefix", () => {
		expect.assertions(2);

		expect(root("./out")).toBe("out");
		expect(root(".\\out")).toBe("out");
	});

	it.for(["out/./nested", "out//nested", "out\\.\\nested\\", "out/nested/../nested"])(
		"should reduce the root spelled %s to one directory name",
		(spelling) => {
			expect.assertions(1);

			expect(root(spelling)).toBe("out/nested");
		},
	);

	it("should resolve a parent segment against the directory it climbs from", () => {
		expect.assertions(3);

		expect(root("out/../out")).toBe("out");
		expect(root("out/nested/..")).toBe("out");
		expect(root("D:/repo/./out/")).toBe("D:/repo/out");
	});

	it("should spell the current directory as a single dot", () => {
		expect.assertions(3);

		expect(root("")).toBe(".");
		expect(root(".")).toBe(".");
		expect(root("./")).toBe(".");
	});

	// Emptying it would leave a root that `isAbsolutePath` and `path.join` both
	// read as the current directory, so the check that refuses absolute roots
	// would wave it through.
	it("should keep the separator a file-system root is made of", () => {
		expect.assertions(2);

		expect(root("/")).toBe("/");
		expect(isAbsolutePath(toPosixRoot("/"))).toBeTrue();
	});

	// `path.posix.normalize` reads `D:` as an ordinary segment, so a climb past
	// it eats the drive and leaves a relative path — one the check that refuses
	// absolute roots waves through, and the walk then leaves the project.
	it("should keep a drive root a parent segment climbs past", () => {
		expect.assertions(3);

		expect(root("D:/../../out")).toBe("D:/out");
		expect(root("D:\\repo\\..\\..\\out")).toBe("D:/out");
		expect(isAbsolutePath(toPosixRoot("D:/../../out"))).toBeTrue();
	});

	// Same reason the file-system root keeps its separator: `D:` alone is not a
	// drive root to `isAbsolutePath`, and `path.join` reads it as relative.
	it("should keep the separator a drive root is made of", () => {
		expect.assertions(2);

		expect(root("D:/")).toBe("D:/");
		expect(isAbsolutePath(toPosixRoot("D:/"))).toBeTrue();
	});

	// A UNC share root is two separators wide. Folded to one it names a
	// directory on this host rather than the share.
	it("should keep a unc share root whole", () => {
		expect.assertions(3);

		expect(root("//server/share/out/")).toBe("//server/share/out");
		expect(root("\\\\server\\share\\out\\..\\out")).toBe("//server/share/out");
		expect(underRoot(toPosixRoot("//server/share"), "player.luau")).toBe(
			"//server/share/player.luau",
		);
	});

	it("should keep a root that climbs above its base", () => {
		expect.assertions(2);

		expect(root("../out")).toBe("../out");
		expect(root("../../out/")).toBe("../../out");
	});
});

describe(underRoot, () => {
	it("should join a relative name onto an ordinary root", () => {
		expect.assertions(1);

		expect(underRoot(toPosixRoot("out"), "shared/player.luau")).toBe("out/shared/player.luau");
	});

	it("should name a file under the current directory by itself", () => {
		expect.assertions(1);

		expect(underRoot(toPosixRoot("."), "shared/player.luau")).toBe("shared/player.luau");
	});

	it("should write one separator under a file-system root", () => {
		expect.assertions(1);

		expect(underRoot(toPosixRoot("/"), "shared/player.luau")).toBe("/shared/player.luau");
	});
});

describe(relativeToRoot, () => {
	it("should undo the join for every root spelling", () => {
		expect.assertions(3);

		expect(relativeToRoot(toPosixRoot("out"), "out/player.luau")).toBe("player.luau");
		expect(relativeToRoot(toPosixRoot("."), "player.luau")).toBe("player.luau");
		expect(relativeToRoot(toPosixRoot("/"), "/player.luau")).toBe("player.luau");
	});

	// The current directory holds every relative name and nothing else. Its
	// prefix is empty, so a boundary test that only strips a prefix claims
	// every key there is — including one named in another frame entirely.
	it("should refuse an absolute key under the current directory", () => {
		expect.assertions(2);

		expect(relativeToRoot(toPosixRoot("."), "/abs/player.luau")).toBeUndefined();
		expect(relativeToRoot(toPosixRoot("."), "D:/abs/player.luau")).toBeUndefined();
	});

	it("should refuse a key outside the root", () => {
		expect.assertions(2);

		// The `/` boundary: a sibling whose name starts with the root's is not
		// a file inside it.
		expect(relativeToRoot(toPosixRoot("out"), "out-tsc/player.luau")).toBeUndefined();
		expect(relativeToRoot(toPosixRoot("out"), "out")).toBeUndefined();
	});
});
