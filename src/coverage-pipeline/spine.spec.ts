import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem, MemoryVolume } from "../../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { normalizeWindowsPath, toPosixRoot } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import type { PreparedSpine, PrepareSpineOptions } from "./spine.ts";
import { prepareSpine, resolveSpineDirectories } from "./spine.ts";

const REPO = normalizeWindowsPath(path.resolve("/repo"));
const SHADOW = `${REPO}/.jest-roblox/coverage`;
const SPINE = `${SHADOW}/.spine`;

/** The copy the place mounts in one demoted level's stead. */
function mounted(level: string): string {
	return `${SPINE}/${level}/.self`;
}

const NO_COPY_IGNORE = createCopyIgnoreMatcher([]);

/** Stands in for the run path's stub bake: one name the mirror never writes. */
const BAKED_NAME = "jest.config.luau";

function isBakeOwned(shadowPath: string): boolean {
	return path.basename(shadowPath) === BAKED_NAME;
}

const OUT = toPosixRoot(path.resolve("/repo/out"));

function at(relativePath: string): PosixRoot {
	return toPosixRoot(`${OUT}/${relativePath}`);
}

/**
 * Two mounts nesting above one root. Declared once and read in both
 * directions, so neither verdict rides on the mount set’s iteration order.
 */
const NESTED_MOUNTS = [at("server"), at("server/modules")];

describe(resolveSpineDirectories, () => {
	it("should return nothing when every root is a mount", () => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server")], new Set([at("client"), at("server")])),
		).toStrictEqual([]);
	});

	it("should walk from the mount down to the root's parent", () => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set([at("server")])),
		).toStrictEqual([at("server"), at("server/modules")]);
	});

	it("should share one chain between roots under the same mount", () => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories(
				[at("server/modules/ecs"), at("server/modules/net")],
				new Set([at("server")]),
			),
		).toStrictEqual([at("server"), at("server/modules")]);
	});

	it("should stop at the deepest mount above the root", () => {
		expect.assertions(1);

		// The shallower mount still loads the deeper one’s own $path, so
		// demoting it would rewrite a tree the place never reads through.
		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set(NESTED_MOUNTS)),
		).toStrictEqual([at("server/modules")]);
	});

	it("should skip a root no mount contains", () => {
		expect.assertions(1);

		expect(
			resolveSpineDirectories([at("server/modules/ecs")], new Set([at("client")])),
		).toStrictEqual([]);
	});

	it("should pick the deepest mount whichever order the tree declares them", () => {
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

	/** Prepares the listed spine levels under the `out/server` luauRoot. */
	function spineOf(
		fileSystem: FileSystem,
		levels: Array<PosixRoot>,
		options: Partial<PrepareSpineOptions> = {},
	): PreparedSpine {
		return prepareSpine({
			fileSystem,
			isCopyIgnored: NO_COPY_IGNORE,
			narrowed: [{ luauRoot: toPosixRoot("out/server"), roots: [], spine: levels }],
			previousNonInstrumented: undefined,
			shadowRoot: SHADOW,
			toSourcePath: (relativePath) => `${REPO}/${relativePath}`,
			...options,
		});
	}

	it("should copy a spine directory's own loose files and nothing below them", () => {
		expect.assertions(3);

		const { fileSystem, volume } = seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/ecs/world.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		spineOf(fileSystem, ["out/server", "out/server/modules"].map(toPosixRoot));

		expect(volume.existsSync(`${mounted("out/server")}/loose.luau`)).toBeTrue();
		expect(volume.existsSync(`${mounted("out/server/modules")}/net.luau`)).toBeTrue();
		expect(volume.existsSync(`${mounted("out/server/modules")}/ecs`)).toBeFalse();
	});

	it("should keep a deeper spine level outside the level above it", () => {
		expect.assertions(3);

		const { fileSystem, volume } = seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		const [above, below] = spineOf(
			fileSystem,
			["out/server", "out/server/modules"].map(toPosixRoot),
		).directories;

		// Rojo mounts a directory whole. A mount that physically held the level
		// below it would serve that level twice — once through this `$path`,
		// once through the explicit child the demote hangs beside it — and the
		// place would carry two Instances of the same name.
		expect(below!.shadowDir.startsWith(`${above!.shadowDir}/`)).toBeFalse();
		expect(volume.readdirSync(above!.shadowDir)).toStrictEqual(["loose.luau"]);
		expect(volume.existsSync(`${below!.shadowDir}/net.luau`)).toBeTrue();
	});

	it("should name the copy the place mounts for each demoted level", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		expect(spineOf(fileSystem, ["out/server"].map(toPosixRoot)).directories).toStrictEqual([
			{ luauRoot: toPosixRoot("out/server"), shadowDir: mounted("out/server") },
		]);
	});

	it("should record each mirrored file against its source hash", () => {
		expect.assertions(1);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		expect(
			Object.keys(spineOf(fileSystem, ["out/server"].map(toPosixRoot)).files),
		).toStrictEqual([at("server/loose.luau")]);
	});

	it("should leave a copy-ignored file out of the spine", () => {
		expect.assertions(2);

		const { fileSystem, volume } = seed({
			[at("server/keep.luau")]: "return nil",
			[at("server/skip.luau.map")]: "{}",
		});

		// Anchored at the mount, so only a path sliced at exactly that boundary
		// matches: an absolute one does not, nor one that keeps its leading
		// separator.
		const result = spineOf(fileSystem, ["out/server"].map(toPosixRoot), {
			isCopyIgnored: createCopyIgnoreMatcher(["skip.luau.map"]),
		});

		expect(volume.existsSync(`${mounted("out/server")}/skip.luau.map`)).toBeFalse();
		expect(Object.keys(result.files)).toStrictEqual([at("server/keep.luau")]);
	});

	it("should report no change when every record carries forward", () => {
		expect.assertions(2);

		const { fileSystem } = seed({ [at("server/loose.luau")]: "return nil" });

		const first = spineOf(fileSystem, ["out/server"].map(toPosixRoot));
		const second = spineOf(fileSystem, ["out/server"].map(toPosixRoot), {
			previousNonInstrumented: first.files,
		});

		expect(first.changed).toBeTrue();
		expect(second.changed).toBeFalse();
	});

	it("should leave a spine file it cannot delete alone", () => {
		expect.assertions(1);

		const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(fileSystem, ["out/server"].map(toPosixRoot));
		volume.unlinkSync(at("server/loose.luau"));
		vi.spyOn(fileSystem, "rmSync").mockImplementation(() => {
			throw new Error("EPERM");
		});

		// Reporting a file as gone when it is still there would have the caller
		// rebuild the place over a lie.
		expect(spineOf(fileSystem, ["out/server"].map(toPosixRoot)).changed).toBeFalse();
	});

	it("should drop a spine file whose source is gone", () => {
		expect.assertions(2);

		const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(fileSystem, ["out/server"].map(toPosixRoot));
		volume.unlinkSync(at("server/loose.luau"));
		const result = spineOf(fileSystem, ["out/server"].map(toPosixRoot));

		expect(volume.existsSync(`${mounted("out/server")}/loose.luau`)).toBeFalse();
		expect(result.changed).toBeTrue();
	});

	describe("when a demoted level carries a file a bake owns", () => {
		/**
		 * The bake's own copy, where the demote makes the place read it.
		 *
		 * @param volume - The volume the spine hangs off.
		 * @param level - The demoted level the bake writes into.
		 */
		function bake(volume: MemoryVolume, level: string): string {
			const bakedPath = `${mounted(level)}/${BAKED_NAME}`;
			volume.mkdirSync(mounted(level), { recursive: true });
			volume.writeFileSync(bakedPath, "return {}\n");
			return bakedPath;
		}

		it("should keep it when this run declares the ownership", () => {
			expect.assertions(2);

			const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });
			const first = spineOf(fileSystem, ["out/server"].map(toPosixRoot), { isBakeOwned });
			const bakedPath = bake(volume, "out/server");

			// Nothing in the source tree produces this file — the bake writes
			// it after the mirror — so clearing it would only be undone
			// moments later, with both halves reporting a change and the place
			// rebuilding on every run.
			const second = spineOf(fileSystem, ["out/server"].map(toPosixRoot), {
				isBakeOwned,
				previousNonInstrumented: first.files,
			});

			expect(volume.existsSync(bakedPath)).toBeTrue();
			expect(second.changed).toBeFalse();
		});

		it("should sweep it when this run declares none", () => {
			expect.assertions(1);

			const { fileSystem, volume } = seed({ [at("server/loose.luau")]: "return nil" });
			const bakedPath = bake(volume, "out/server");

			// A run with no bake wants its place free of what an earlier
			// baking run left in the shared shadow.
			spineOf(fileSystem, ["out/server"].map(toPosixRoot));

			expect(volume.existsSync(bakedPath)).toBeFalse();
		});
	});
});
