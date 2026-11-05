import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import {
	createCopyIgnoreMatcher,
	discoverRootFiles,
	hashCopyIgnorePatterns,
	isInstrumentableFile,
	isNonInstrumentedFile,
	isSkippedDirectory,
	walkLuauDirectory,
} from "./discover-files.ts";
import type { InstrumentUniverse } from "./instrument-universe.ts";

function universeOf(include: string): InstrumentUniverse {
	return { digest: include, includes: picomatch(include) };
}

describe(discoverRootFiles, () => {
	it("should discover .luau files", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out/shared", { recursive: true });
		volume.writeFileSync("out/init.luau", "");
		volume.writeFileSync("out/shared/player.luau", "");

		const result = discoverRootFiles(posixRoot("out"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set(["init.luau", "shared/player.luau"]));
	});

	// A root reaches the walk however the config spelled it, and every spelling
	// here names the same directory. A walk that states each file by slicing
	// the root's own length off the front offsets every name instead, which
	// surfaces far from the config as an ENOENT on a file that never existed.
	it.for(["out/../out", "out/.", "out//", "out/./"])(
		"should name walked files the same for a root spelled %s",
		async (luauRoot) => {
			expect.assertions(1);

			const { fileSystem, volume } = createMemoryFileSystem();

			volume.mkdirSync("out/shared", { recursive: true });
			volume.writeFileSync("out/init.luau", "");
			volume.writeFileSync("out/shared/player.luau", "");

			const result = discoverRootFiles(posixRoot(luauRoot), { fileSystem }).instrumentable;

			expect(result).toStrictEqual(new Set(["init.luau", "shared/player.luau"]));
		},
	);

	// A file-system root is the one root that already ends in a separator, so
	// a walk that writes its own doubles it. Reachable in workspace mode,
	// where roots are absolute and no check refuses this one.
	it("should walk a file-system root without doubling the separator", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("/shared", { recursive: true });
		volume.writeFileSync("/init.luau", "");
		volume.writeFileSync("/shared/player.luau", "");

		const result = discoverRootFiles(posixRoot("/"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set(["init.luau", "shared/player.luau"]));
	});

	it("should name walked files relative to a root spelled as the current directory", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("shared", { recursive: true });
		volume.writeFileSync("init.luau", "");
		volume.writeFileSync("shared/player.luau", "");

		const result = discoverRootFiles(posixRoot("."), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set(["init.luau", "shared/player.luau"]));
	});

	it("should exclude spec, test, and snap files", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out", { recursive: true });
		volume.writeFileSync("out/init.luau", "");
		volume.writeFileSync("out/init.spec.luau", "");
		volume.writeFileSync("out/init.test.luau", "");
		volume.writeFileSync("out/init.snap.luau", "");
		volume.writeFileSync("out/init.spec.lua", "");
		volume.writeFileSync("out/init.test.lua", "");
		volume.writeFileSync("out/init.snap.lua", "");

		const result = discoverRootFiles(posixRoot("out"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set(["init.luau"]));
	});

	it("should skip node_modules and dot directories", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out/node_modules", { recursive: true });
		volume.mkdirSync("out/.hidden", { recursive: true });
		volume.mkdirSync("out/.jest-roblox/coverage", { recursive: true });
		volume.writeFileSync("out/node_modules/vendor.luau", "");
		volume.writeFileSync("out/.hidden/secret.luau", "");
		volume.writeFileSync("out/.jest-roblox/coverage/cached.luau", "");

		const result = discoverRootFiles(posixRoot("out"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set());
	});

	it("should include .lua files", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out", { recursive: true });
		volume.writeFileSync("out/init.lua", "");

		const result = discoverRootFiles(posixRoot("out"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set(["init.lua"]));
	});

	it("should return empty set for empty directory", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out", { recursive: true });

		const result = discoverRootFiles(posixRoot("out"), { fileSystem }).instrumentable;

		expect(result).toStrictEqual(new Set());
	});

	it("should treat every prod file as instrumentable without a universe", async () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out", { recursive: true });
		volume.writeFileSync("out/player.luau", "");

		expect(discoverRootFiles(posixRoot("out"), { fileSystem }).excluded).toStrictEqual(
			new Set(),
		);
	});

	it("should leave a copy-ignored prod file out of both sets", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out/vendor", { recursive: true });
		volume.writeFileSync("out/player.luau", "");
		volume.writeFileSync("out/vendor/dep.luau", "");

		// Neither probed nor mirrored: the instrumenter reads this same split,
		// so a path missing here is a path nothing writes into the shadow.
		const result = discoverRootFiles(posixRoot("out"), {
			fileSystem,
			isCopyIgnored: createCopyIgnoreMatcher(["**/vendor/**", "vendor"]),
		});

		expect(result.instrumentable).toStrictEqual(new Set(["player.luau"]));
		expect(result.excluded).toStrictEqual(new Set());
	});

	it("should split prod files by the coverage universe", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("out/ecs", { recursive: true });
		volume.mkdirSync("out/ui", { recursive: true });
		volume.writeFileSync("out/ecs/move.luau", "");
		volume.writeFileSync("out/ui/button.luau", "");

		const universe = universeOf("out/ecs/**/*.luau");
		const result = discoverRootFiles(posixRoot("out"), { fileSystem, universe });

		expect(result.instrumentable).toStrictEqual(new Set(["ecs/move.luau"]));
		expect(result.excluded).toStrictEqual(new Set(["ui/button.luau"]));
	});

	// The universe names files as `path.join` writes them, which for the
	// current directory is the bare name. A root that pastes its own `.` on
	// the front asks about a file the universe has never heard of, so every
	// probe silently demotes to a mirrored copy and the run reports no
	// coverage at all.
	it("should split prod files by the universe under a current-directory root", async () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();

		volume.mkdirSync("ecs", { recursive: true });
		volume.mkdirSync("ui", { recursive: true });
		volume.writeFileSync("ecs/move.luau", "");
		volume.writeFileSync("ui/button.luau", "");

		const universe = universeOf("ecs/**/*.luau");
		const result = discoverRootFiles(posixRoot("."), { fileSystem, universe });

		expect(result.instrumentable).toStrictEqual(new Set(["ecs/move.luau"]));
		expect(result.excluded).toStrictEqual(new Set(["ui/button.luau"]));
	});
});

describe(createCopyIgnoreMatcher, () => {
	it("should match paths anchored at the root", () => {
		expect.assertions(2);

		const isIgnored = createCopyIgnoreMatcher(["vendor/**"]);

		expect(isIgnored("vendor/dep.luau")).toBeTrue();
		expect(isIgnored("shared/vendor/dep.luau")).toBeFalse();
	});
});

describe(hashCopyIgnorePatterns, () => {
	it("should ignore pattern order", () => {
		expect.assertions(1);

		expect(hashCopyIgnorePatterns(["a", "b"])).toBe(hashCopyIgnorePatterns(["b", "a"]));
	});

	it("should change when a pattern changes", () => {
		expect.assertions(1);

		expect(hashCopyIgnorePatterns(["a"])).not.toBe(hashCopyIgnorePatterns(["a", "b"]));
	});
});

describe(isNonInstrumentedFile, () => {
	it.for<[string, boolean]>([
		["a.spec.luau", true],
		["a.test.lua", true],
		["a.snap.luau", true],
		["a.luau", false],
	])("should classify %s as non-instrumented: %s", ([name, expected]) => {
		expect.assertions(1);

		expect(isNonInstrumentedFile(name)).toBe(expected);
	});
});

describe(isInstrumentableFile, () => {
	it.for<[string, boolean]>([
		["a.luau", true],
		["a.lua", true],
		["a.spec.luau", false],
		["a.json", false],
	])("should classify %s as instrumentable: %s", ([name, expected]) => {
		expect.assertions(1);

		expect(isInstrumentableFile(name)).toBe(expected);
	});
});

describe(isSkippedDirectory, () => {
	it.for<[string, boolean]>([
		["node_modules", true],
		[".git", true],
		["shared", false],
	])("should skip %s: %s", ([name, expected]) => {
		expect.assertions(1);

		expect(isSkippedDirectory(name)).toBe(expected);
	});
});

describe(walkLuauDirectory, () => {
	it("should report every directory it descends into and skip what the filter claims", () => {
		expect.assertions(2);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync("out/shared/empty", { recursive: true });
		volume.mkdirSync("out/vendor", { recursive: true });
		volume.writeFileSync("out/shared/a.luau", "");
		volume.writeFileSync("out/vendor/b.luau", "");
		const directories: Array<string> = [];
		const results: Array<string> = [];

		walkLuauDirectory({
			directory: "out",
			fileSystem,
			filter: {
				accept: isInstrumentableFile,
				onDirectory: (relativePath) => {
					directories.push(relativePath);
				},
				skip: (relativePath) => relativePath === "vendor",
			},
			results,
		});

		expect(results).toStrictEqual(["shared/a.luau"]);
		expect(directories.sort()).toStrictEqual(["shared", "shared/empty"]);
	});
});
