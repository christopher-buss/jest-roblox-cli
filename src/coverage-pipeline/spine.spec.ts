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

const NO_COPY_IGNORE = createCopyIgnoreMatcher([]);

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

		expect(vol.existsSync(`${SPINE}/out/server/loose.luau`)).toBeTrue();
		expect(vol.existsSync(`${SPINE}/out/server/modules/net.luau`)).toBeTrue();
		expect(vol.existsSync(`${SPINE}/out/server/modules/ecs`)).toBeFalse();
	});

	it("should name the copy the place mounts for each demoted level", () => {
		expect.assertions(1);

		seed({ [at("server/loose.luau")]: "return nil" });

		expect(spineOf(["out/server"]).directories).toStrictEqual([
			{ luauRoot: "out/server", shadowDir: `${SPINE}/out/server` },
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

		expect(vol.existsSync(`${SPINE}/out/server/skip.luau.map`)).toBeFalse();
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

		expect(vol.existsSync(`${SPINE}/out/server/loose.luau`)).toBeFalse();
		expect(result.changed).toBeTrue();
	});
});
