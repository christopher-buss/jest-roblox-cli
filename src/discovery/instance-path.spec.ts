import type { Mount } from "@isentinel/rojo-utils";

import { describe, expect, it } from "vitest";

import { createInstancePathResolver } from "./instance-path.ts";

const SERVER_MOUNT: Mount = {
	dataModelPath: "ServerScriptService/PkgServer",
	fsPath: "out/server",
};
const SHARED_MOUNT: Mount = { dataModelPath: "ReplicatedStorage/PkgShared", fsPath: "out/shared" };
const TS_MAPPING = { outDir: "out", rootDir: "src" };

describe(createInstancePathResolver, () => {
	it("should return the mount name and the path below it for a luau source", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/shared/lib/example.spec.luau")).toBe("PkgShared/lib/example.spec");
	});

	it("should map a TypeScript source through the tsconfig rootDir/outDir rewrite", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		expect(resolve("src/server/modules/ecs/item-use-system/index.test.ts")).toBe(
			"PkgServer/modules/ecs/item-use-system/init.test",
		);
	});

	// Without the mount name on the front the path below the mount is a bare
	// suffix, so naming `a/index.test.ts` would also select the nested namesake.
	it("should not let a named file's path be a suffix of a deeper namesake", () => {
		expect.assertions(2);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		const named = resolve("src/server/a/index.test.ts");
		// Matched the way Jest-on-Roblox does: unanchored and case-insensitive.
		const pattern = new RegExp(String(named), "i");

		expect(named).toBe("PkgServer/a/init.test");
		expect(pattern.test("ServerScriptService/PkgServer/nested/a/init.test")).toBeFalse();
	});

	// `rootDir` is not a project-only key, so discovery can be based at a
	// subdirectory while the mounts stay relative to the Rojo root.
	it("should resolve when the file base and the mount base differ", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [
				{ dataModelPath: "ServerScriptService/PkgServer", fsPath: "packages/foo/out" },
			],
			rootDirectory: "/repo/packages/foo/src",
			tsconfigMappings: [{ outDir: "packages/foo/out", rootDir: "packages/foo/src" }],
		});

		expect(resolve("a/index.spec.ts")).toBe("PkgServer/a/init.spec");
	});

	it("should let the mount pick between mappings that share a rootDir", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			// A type-check-only tsconfig emitting to `out-tsc` sits alongside the
			// real one; only `out` is mounted, so only `out` can win.
			tsconfigMappings: [{ outDir: "out-tsc", rootDir: "src" }, TS_MAPPING],
		});

		expect(resolve("src/server/systems/attack/index.test.ts")).toBe(
			"PkgServer/systems/attack/init.test",
		);
	});

	it("should treat a rootDirs mapping rooted at dot as owning every source", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			tsconfigMappings: [{ outDir: "out", rootDir: "." }],
		});

		expect(resolve("server/systems/attack/index.test.ts")).toBe(
			"PkgServer/systems/attack/init.test",
		);
	});

	// A Luau source is already in the output namespace. A `rootDirs` tsconfig
	// collapses to a rootDir owning every path under the base, so rebasing one
	// would prepend the outDir a second time and match nothing.
	it("should not rebase a pure-Luau source that already sits under the outDir", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [{ dataModelPath: "ReplicatedStorage/TS", fsPath: "out" }],
			rootDirectory: "/repo",
			tsconfigMappings: [{ outDir: "out", rootDir: "." }],
		});

		expect(resolve("out/shared/lib/example.spec.luau")).toBe("TS/shared/lib/example.spec");
	});

	it("should match a project that mounts its TypeScript sources directly", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [{ dataModelPath: "ServerScriptService/TS", fsPath: "src/server" }],
			rootDirectory: "/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		expect(resolve("src/server/systems/attack/index.test.ts")).toBe(
			"TS/systems/attack/init.test",
		);
	});

	it("should keep an index stem for a pure-Luau source", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/shared/lib/index.spec.luau")).toBe("PkgShared/lib/index.spec");
	});

	// `path.resolve` on Windows stamps the cwd's drive onto a drive-less root, so
	// a discovered file can carry a letter its root never had.
	it("should ignore a drive letter the root directory does not carry", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("D:/repo/out/shared/lib/example.spec.luau")).toBe(
			"PkgShared/lib/example.spec",
		);
	});

	it("should resolve an absolute Windows path against the root directory", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "D:/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "D:/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		expect(resolve("D:\\repo\\src\\server\\systems\\attack\\index.test.ts")).toBe(
			"PkgServer/systems/attack/init.test",
		);
	});

	it("should return the bare filename for a file directly under the mount root", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/shared/example.spec.luau")).toBe("PkgShared/example.spec");
	});

	it("should pick the deepest mount when one mount nests inside another", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [{ dataModelPath: "ReplicatedStorage", fsPath: "out" }, SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/shared/lib/example.spec.luau")).toBe("PkgShared/lib/example.spec");
	});

	it("should return undefined when no mount owns the file", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/client/example.spec.luau")).toBeUndefined();
	});

	it("should return undefined when a TypeScript source has no tsconfig mapping to a mount", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("src/server/systems/attack/index.test.ts")).toBeUndefined();
	});

	it("should not treat a sibling directory sharing the mount prefix as a match", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SHARED_MOUNT],
			rootDirectory: "/repo",
		});

		expect(resolve("out/shared-extra/example.spec.luau")).toBeUndefined();
	});

	it("should rename only the filename stem, never a directory named index", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		expect(resolve("src/server/index/index.test.ts")).toBe("PkgServer/index/init.test");
	});

	it("should rename a bare index module with no test suffix", () => {
		expect.assertions(1);

		const resolve = createInstancePathResolver({
			mountBase: "/repo",
			mounts: [SERVER_MOUNT],
			rootDirectory: "/repo",
			tsconfigMappings: [TS_MAPPING],
		});

		expect(resolve("src/server/systems/attack/index.ts")).toBe("PkgServer/systems/attack/init");
	});
});
