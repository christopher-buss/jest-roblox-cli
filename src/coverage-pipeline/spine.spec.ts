import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { createCopyIgnoreMatcher } from "./discover-files.ts";
import type { PreparedSpine, PrepareSpineOptions } from "./spine.ts";
import { prepareSpine, resolveSpineDirectories } from "./spine.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

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

const OUT = normalizeWindowsPath(path.resolve("/repo/out"));

function at(relativePath: string): string {
	return `${OUT}/${relativePath}`;
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
	function seed(files: Record<string, string>): void {
		onTestFinished(() => {
			vol.reset();
		});
		vol.fromJSON(files);
	}

	/** Prepares the listed spine levels under the `out/server` luauRoot. */
	function spineOf(
		levels: Array<string>,
		options: Partial<PrepareSpineOptions> = {},
	): PreparedSpine {
		return prepareSpine({
			isCopyIgnored: NO_COPY_IGNORE,
			narrowed: [{ luauRoot: "out/server", roots: [], spine: levels }],
			previousNonInstrumented: undefined,
			shadowRoot: SHADOW,
			toSourcePath: (relativePath) => `${REPO}/${relativePath}`,
			...options,
		});
	}

	it("should copy a spine directory's own loose files and nothing below them", () => {
		expect.assertions(3);

		seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/ecs/world.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		spineOf(["out/server", "out/server/modules"]);

		expect(vol.existsSync(`${mounted("out/server")}/loose.luau`)).toBeTrue();
		expect(vol.existsSync(`${mounted("out/server/modules")}/net.luau`)).toBeTrue();
		expect(vol.existsSync(`${mounted("out/server/modules")}/ecs`)).toBeFalse();
	});

	it("should keep a deeper spine level outside the level above it", () => {
		expect.assertions(3);

		seed({
			[at("server/loose.luau")]: "return nil",
			[at("server/modules/net.luau")]: "return nil",
		});

		const [above, below] = spineOf(["out/server", "out/server/modules"]).directories;

		// Rojo mounts a directory whole. A mount that physically held the level
		// below it would serve that level twice — once through this `$path`,
		// once through the explicit child the demote hangs beside it — and the
		// place would carry two Instances of the same name.
		expect(below!.shadowDir.startsWith(`${above!.shadowDir}/`)).toBeFalse();
		expect(vol.readdirSync(above!.shadowDir)).toStrictEqual(["loose.luau"]);
		expect(vol.existsSync(`${below!.shadowDir}/net.luau`)).toBeTrue();
	});

	it("should name the copy the place mounts for each demoted level", () => {
		expect.assertions(1);

		seed({ [at("server/loose.luau")]: "return nil" });

		expect(spineOf(["out/server"]).directories).toStrictEqual([
			{ luauRoot: "out/server", shadowDir: mounted("out/server") },
		]);
	});

	it("should record each mirrored file against its source hash", () => {
		expect.assertions(1);

		seed({ [at("server/loose.luau")]: "return nil" });

		expect(Object.keys(spineOf(["out/server"]).files)).toStrictEqual([at("server/loose.luau")]);
	});

	it("should leave a copy-ignored file out of the spine", () => {
		expect.assertions(2);

		seed({
			[at("server/keep.luau")]: "return nil",
			[at("server/skip.luau.map")]: "{}",
		});

		// Anchored at the mount, so only a path sliced at exactly that boundary
		// matches: an absolute one does not, nor one that keeps its leading
		// separator.
		const result = spineOf(["out/server"], {
			isCopyIgnored: createCopyIgnoreMatcher(["skip.luau.map"]),
		});

		expect(vol.existsSync(`${mounted("out/server")}/skip.luau.map`)).toBeFalse();
		expect(Object.keys(result.files)).toStrictEqual([at("server/keep.luau")]);
	});

	it("should report no change when every record carries forward", () => {
		expect.assertions(2);

		seed({ [at("server/loose.luau")]: "return nil" });

		const first = spineOf(["out/server"]);
		const second = spineOf(["out/server"], { previousNonInstrumented: first.files });

		expect(first.changed).toBeTrue();
		expect(second.changed).toBeFalse();
	});

	it("should leave a spine file it cannot delete alone", async () => {
		expect.assertions(1);

		seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(["out/server"]);
		vol.unlinkSync(at("server/loose.luau"));
		const nodeFs = await import("node:fs");
		vi.spyOn(nodeFs, "rmSync").mockImplementation(() => {
			throw new Error("EPERM");
		});

		// Reporting a file as gone when it is still there would have the caller
		// rebuild the place over a lie.
		expect(spineOf(["out/server"]).changed).toBeFalse();
	});

	it("should drop a spine file whose source is gone", () => {
		expect.assertions(2);

		seed({ [at("server/loose.luau")]: "return nil" });

		spineOf(["out/server"]);
		vol.unlinkSync(at("server/loose.luau"));
		const result = spineOf(["out/server"]);

		expect(vol.existsSync(`${mounted("out/server")}/loose.luau`)).toBeFalse();
		expect(result.changed).toBeTrue();
	});

	describe("when a demoted level carries a file a bake owns", () => {
		/** The bake's own copy, where the demote makes the place read it. */
		function bake(level: string): string {
			const bakedPath = `${mounted(level)}/${BAKED_NAME}`;
			vol.mkdirSync(mounted(level), { recursive: true });
			vol.writeFileSync(bakedPath, "return {}\n");
			return bakedPath;
		}

		it("should keep it when this run declares the ownership", () => {
			expect.assertions(2);

			seed({ [at("server/loose.luau")]: "return nil" });
			const first = spineOf(["out/server"], { isBakeOwned });
			const bakedPath = bake("out/server");

			// Nothing in the source tree produces this file — the bake writes
			// it after the mirror — so clearing it would only be undone
			// moments later, with both halves reporting a change and the place
			// rebuilding on every run.
			const second = spineOf(["out/server"], {
				isBakeOwned,
				previousNonInstrumented: first.files,
			});

			expect(vol.existsSync(bakedPath)).toBeTrue();
			expect(second.changed).toBeFalse();
		});

		it("should sweep it when this run declares none", () => {
			expect.assertions(1);

			seed({ [at("server/loose.luau")]: "return nil" });
			const bakedPath = bake("out/server");

			// A run with no bake wants its place free of what an earlier
			// baking run left in the shared shadow.
			spineOf(["out/server"]);

			expect(vol.existsSync(bakedPath)).toBeFalse();
		});
	});
});
