import type { MemoryFileSystem, MemoryVolume } from "@isentinel/dev-vitest-utils";
import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

import * as path from "node:path";
import { describe, it, vi } from "vitest";

import { posixPath } from "#test/helpers/posix-path.ts";
import { copyIgnoreMatcher } from "#test/helpers/unit/coverage-copy-ignore.ts";
import { posixRoot } from "#test/helpers/unit/posix-root.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { PreparedSpine, PrepareSpineOptions } from "./spine.ts";
import { createShadowLayout, prepareSpine, resolveSpineDirectories } from "./spine.ts";

const REPO = posixPath(path.resolve("/repo"));
const SHADOW = `${REPO}/.jest-roblox/coverage`;
const SPINE = `${SHADOW}/.spine`;

function mounted(level: string): string {
	return `${SPINE}/${level}/.self`;
}

const NO_COPY_IGNORE = copyIgnoreMatcher([]);

const BAKED_NAME = "jest.config.luau";

function isBakeOwned(shadowPath: string): boolean {
	return path.basename(shadowPath) === BAKED_NAME;
}

const OUT = posixRoot(path.resolve("/repo/out"));

function at(relativePath: string): PosixRoot {
	return posixRoot(`${OUT}/${relativePath}`);
}

const NESTED_MOUNTS = [at("server"), at("server/modules")];

describe(createShadowLayout, () => {
	it("should serve a directory inside a narrowed root from the shadow", ({ expect }) => {
		expect.assertions(2);

		const layout = createShadowLayout("/shadow", [
			{ luauRoot: posixRoot("src"), roots: [posixRoot("src/core")], spine: [] },
		]);

		expect(layout.isShadowed("src/core/ecs")).toBeTrue();
		expect(layout.isShadowed("src/other")).toBeFalse();
	});

	it("should serve a demoted mount from the shadow", ({ expect }) => {
		expect.assertions(1);

		const layout = createShadowLayout("/shadow", [
			{
				luauRoot: posixRoot("src"),
				roots: [posixRoot("src/core")],
				spine: [posixRoot("src")],
			},
		]);

		expect(layout.isShadowed("src")).toBeTrue();
	});

	it("should read a root that narrowed to nothing from source", ({ expect }) => {
		expect.assertions(1);

		const layout = createShadowLayout("/shadow", [
			{ luauRoot: posixRoot("test"), roots: [], spine: [] },
		]);

		expect(layout.isShadowed("test")).toBeFalse();
	});
});

describe(resolveSpineDirectories, () => {
	it("should return nothing when every root is a mount", ({ expect }) => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server")], new Set([at("client"), at("server")])),
		).toStrictEqual([]);
	});

	it("should walk from the mount down to the root's parent", ({ expect }) => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set([at("server")])),
		).toStrictEqual([at("server"), at("server/modules")]);
	});

	it("should share one chain between roots under the same mount", ({ expect }) => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories(
				[at("server/modules/ecs"), at("server/modules/net")],
				new Set([at("server")]),
			),
		).toStrictEqual([at("server"), at("server/modules")]);
	});

	it("should stop at the deepest mount above the root", ({ expect }) => {
		expect.assertions(1);

		// The shallower mount still loads the deeper one’s own $path, so
		// demoting it would rewrite a tree the place never reads through.
		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set(NESTED_MOUNTS)),
		).toStrictEqual([at("server/modules")]);
	});

	it("should skip a root no mount contains", ({ expect }) => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set([at("client")])),
		).toStrictEqual([]);
	});

	it("should pick the deepest mount whichever order the tree declares them", ({ expect }) => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories(
				[at("server/modules/ecs")],
				new Set(NESTED_MOUNTS.toReversed()),
			),
		).toStrictEqual([at("server/modules")]);
	});
});

describe(prepareSpine, () => {
	function seed(files: Record<string, string>): MemoryFileSystem {
		return createMemoryFileSystem(files);
	}

	function spineOf(
		fileSystem: FileSystem,
		{
			levels,
			options = {},
		}: { levels: Array<PosixRoot>; options?: Partial<PrepareSpineOptions> },
	): PreparedSpine {
		return prepareSpine({
			fileSystem,
			isCopyIgnored: NO_COPY_IGNORE,
			narrowed: [{ luauRoot: posixRoot("out/server"), roots: [], spine: levels }],
			previousNonInstrumented: undefined,
			shadowRoot: SHADOW,
			toSourcePath: (relativePath) => `${REPO}/${relativePath}`,
			...options,
		});
	}

	it("should copy a spine directory's own loose files and nothing below them", ({ expect }) => {
		expect.assertions(3);

		const { fileSystem, volume } = seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/ecs/world.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		spineOf(fileSystem, { levels: ["out/server", "out/server/modules"].map(posixRoot) });

		expect(volume.existsSync(`${mounted("out/server")}/loose.luau`)).toBeTrue();
		expect(volume.existsSync(`${mounted("out/server/modules")}/net.luau`)).toBeTrue();
		expect(volume.existsSync(`${mounted("out/server/modules")}/ecs`)).toBeFalse();
	});

	it("should keep a deeper spine level outside the level above it", ({ expect }) => {
		expect.assertions(3);

		const { fileSystem, volume } = seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		const [above, below] = spineOf(fileSystem, {
			levels: ["out/server", "out/server/modules"].map(posixRoot),
		}).directories;

		// Rojo mounts a directory whole. A mount that physically held the level
		// below it would serve that level twice (once through this `$path`,
		// once through the explicit child the demote hangs beside it), and the
		// place would carry two Instances of the same name.
		expect(below!.shadowDir.startsWith(`${above!.shadowDir}/`)).toBeFalse();
		expect(volume.readdirSync(above!.shadowDir)).toStrictEqual(["loose.luau"]);
		expect(volume.existsSync(`${below!.shadowDir}/net.luau`)).toBeTrue();
	});

	it("should name the copy the place mounts for each demoted level", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		expect(
			spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) }).directories,
		).toStrictEqual([{ luauRoot: posixRoot("out/server"), shadowDir: mounted("out/server") }]);
	});

	it("should record each mirrored file against its source hash", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		expect(
			Object.keys(spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) }).files),
		).toStrictEqual([at("server/loose.luau")]);
	});

	it("should leave a copy-ignored file out of the spine", ({ expect }) => {
		expect.assertions(2);

		const { fileSystem, volume } = seed({
			[at("server/keep.luau")]: "return nil",
			[at("server/skip.luau.map")]: "{}",
		});

		// Anchored at the mount, so only a path sliced at exactly that boundary
		// matches: an absolute one does not, nor one that keeps its leading
		// separator.
		const result = spineOf(fileSystem, {
			levels: ["out/server"].map(posixRoot),
			options: {
				isCopyIgnored: copyIgnoreMatcher(["skip.luau.map"]),
			},
		});

		expect(volume.existsSync(`${mounted("out/server")}/skip.luau.map`)).toBeFalse();
		expect(Object.keys(result.files)).toStrictEqual([at("server/keep.luau")]);
	});

	it("should report no change when every record carries forward", ({ expect }) => {
		expect.assertions(2);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		const first = spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) });
		const second = spineOf(fileSystem, {
			levels: ["out/server"].map(posixRoot),
			options: {
				previousNonInstrumented: first.files,
			},
		});

		expect(first.changed).toBeTrue();
		expect(second.changed).toBeFalse();
	});

	it("should leave a spine file it cannot delete alone", ({ expect }) => {
		expect.assertions(1);

		const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) });
		volume.unlinkSync(at("server/loose.luau"));
		vi.spyOn(fileSystem, "rmSync").mockThrow(new Error("EPERM"));

		// Reporting a file as gone when it is still there would have the caller
		// rebuild the place over a lie.
		expect(spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) }).changed).toBeFalse();
	});

	it("should drop a spine file whose source is gone", ({ expect }) => {
		expect.assertions(2);

		const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) });
		volume.unlinkSync(at("server/loose.luau"));
		const result = spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) });

		expect(volume.existsSync(`${mounted("out/server")}/loose.luau`)).toBeFalse();
		expect(result.changed).toBeTrue();
	});

	describe("when a demoted level carries a file a bake owns", () => {
		function bake(volume: MemoryVolume): string {
			const bakedPath = `${mounted("out/server")}/${BAKED_NAME}`;
			volume.mkdirSync(mounted("out/server"), { recursive: true });
			volume.writeFileSync(bakedPath, "return {}\n");
			return bakedPath;
		}

		it("should keep it when this run declares the ownership", ({ expect }) => {
			expect.assertions(2);

			const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });
			const first = spineOf(fileSystem, {
				levels: ["out/server"].map(posixRoot),
				options: { isBakeOwned },
			});
			const bakedPath = bake(volume);

			// Nothing in the source tree produces this file (the bake writes
			// it after the mirror), so clearing it would only be undone
			// moments later, with both halves reporting a change and the place
			// rebuilding on every run.
			const second = spineOf(fileSystem, {
				levels: ["out/server"].map(posixRoot),
				options: {
					isBakeOwned,
					previousNonInstrumented: first.files,
				},
			});

			expect(volume.existsSync(bakedPath)).toBeTrue();
			expect(second.changed).toBeFalse();
		});

		it("should sweep it when this run declares none", ({ expect }) => {
			expect.assertions(1);

			const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });
			const bakedPath = bake(volume);

			// A run with no bake wants its place free of what an earlier
			// baking run left in the shared shadow.
			spineOf(fileSystem, { levels: ["out/server"].map(posixRoot) });

			expect(volume.existsSync(bakedPath)).toBeFalse();
		});
	});
});
