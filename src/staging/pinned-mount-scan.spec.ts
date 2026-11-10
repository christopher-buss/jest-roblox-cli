import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { configErrorLike } from "#test/mocks/run-config-error.ts";
import { seed } from "#test/mocks/staged-project.ts";
import type { PinnedMount } from "./pinned-mount-scan.ts";
import { findPinnedMounts } from "./pinned-mount-scan.ts";

const ASSETS = path.resolve("/repo/game-assets");
const TERRAIN_XML = '<roblox version="4"><Item class="Terrain" referent="0"></Item></roblox>';
const MODEL_XML = '<roblox version="4"><Item class="Model" referent="0"></Item></roblox>';

function scan(
	memory: MemoryFileSystem,
	{ globIgnorePaths = [], stage }: { globIgnorePaths?: Array<string>; stage: RojoTreeNode },
): Array<PinnedMount> {
	return findPinnedMounts({ fileSystem: memory.fileSystem, globIgnorePaths, stage });
}

function directoryStage(directory: string): RojoTreeNode {
	return { pkg: { $className: "Folder", Workspace: { $className: "Folder", $path: directory } } };
}

function sources(mounts: Array<PinnedMount>): Array<string> {
	return mounts.map((mount) => posixPath(mount.source));
}

describe(findPinnedMounts, () => {
	it("should skip a mount the project already ignores", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		const stage = { pkg: { $className: "Folder", Terrain: { $path: model } } };

		// A consumer who worked around this bug by ignoring the file must not
		// have an empty stand-in put back in its place.
		expect(
			scan(seed({ [model]: TERRAIN_XML }), {
				globIgnorePaths: ["**/Workspace/Terrain.rbxmx"],
				stage,
			}),
		).toBeEmpty();
	});

	it("should match an absolute ignore path after removing the Windows drive letter", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		const normalizedWithoutDrive = model.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
		const stage = { pkg: { $className: "Folder", Terrain: { $path: model } } };

		expect(
			scan(seed({ [model]: TERRAIN_XML }), {
				globIgnorePaths: [normalizedWithoutDrive],
				stage,
			}),
		).toBeEmpty();
	});

	it("should skip a mounted entry the project already ignores", () => {
		expect.assertions(1);

		const memory = seed({ [path.join(ASSETS, "Workspace/Terrain.rbxmx")]: TERRAIN_XML });

		expect(
			scan(memory, {
				globIgnorePaths: ["**/Terrain.rbxmx"],
				stage: directoryStage(path.join(ASSETS, "Workspace")),
			}),
		).toBeEmpty();
	});

	it("should ignore a mount that is not on disk", () => {
		expect.assertions(1);

		const stage = {
			pkg: { $className: "Folder", src: { $path: path.join(ASSETS, "missing") } },
		};

		expect(scan(seed(), { stage })).toBeEmpty();
	});

	it("should ignore a mount that is a file rojo reads without a class", () => {
		expect.assertions(1);

		const source = path.join(ASSETS, "init.luau");
		const stage = { pkg: { $className: "Folder", src: { $path: source } } };

		expect(scan(seed({ [source]: "return {}" }), { stage })).toBeEmpty();
	});

	it("should ignore a mounted model whose own root is not pinned", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "pod.rbxmx");
		const stage = { pkg: { $className: "Folder", Pod: { $path: model } } };

		expect(scan(seed({ [model]: MODEL_XML }), { stage })).toBeEmpty();
	});

	it("should not report a buried pinned class the project already ignores", () => {
		expect.assertions(1);

		const top = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		const memory = seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: TERRAIN_XML,
			[top]: TERRAIN_XML,
		});

		expect(
			sources(
				scan(memory, {
					globIgnorePaths: ["**/lobby/Terrain.rbxmx"],
					stage: directoryStage(path.join(ASSETS, "Workspace")),
				}),
			),
		).toStrictEqual([posixPath(top)]);
	});

	it("should apply ignore globs to dot-directories", () => {
		expect.assertions(1);

		const memory = seed({
			[path.join(ASSETS, "Workspace/.generated/Terrain.rbxmx")]: TERRAIN_XML,
		});

		expect(
			scan(memory, {
				globIgnorePaths: ["**/*"],
				stage: directoryStage(path.join(ASSETS, "Workspace")),
			}),
		).toBeEmpty();
	});

	it("should report a pinned class buried below the mount rather than rebuilding it", () => {
		expect.assertions(1);

		const memory = seed({
			[path.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")]: TERRAIN_XML,
		});

		// Such a file is in the wrong parent in the consumer's own place too, so
		// no stand-in would make it load.
		const mountRoot = path.join(ASSETS, "Workspace");
		const buried = path
			.join(ASSETS, "Workspace/maps/lobby/Terrain.rbxmx")
			.replaceAll("\\", "/");

		expect(() => scan(memory, { stage: directoryStage(mountRoot) })).toThrow(
			configErrorLike(
				`"${buried}" declares Terrain, which the engine parents only under one service, but it is nested inside the mount at "${mountRoot}" rather than sitting directly in it. ` +
					"Roblox rejects it wherever that mount lands, so move the file up to the directory mounted at its own service, or drop it from the project with `globIgnorePaths`.",
			),
		);
	});

	it("should walk past a nested directory that holds no pinned class", () => {
		expect.assertions(1);

		const top = path.join(ASSETS, "Workspace/Terrain.rbxmx");
		const memory = seed({
			[path.join(ASSETS, "Workspace/maps/lobby/pod.rbxmx")]: MODEL_XML,
			[top]: TERRAIN_XML,
		});

		expect(
			sources(scan(memory, { stage: directoryStage(path.join(ASSETS, "Workspace")) })),
		).toStrictEqual([posixPath(top)]);
	});

	it("should leave an auto-mounted directory of ordinary files unreported", () => {
		expect.assertions(1);

		const memory = seed({
			[path.join(ASSETS, "Workspace/maps/config.model.json")]: '{"ClassName":"Model"}',
			[path.join(ASSETS, "Workspace/maps/init.luau")]: "return {}",
		});

		expect(scan(memory, { stage: directoryStage(path.join(ASSETS, "Workspace")) })).toBeEmpty();
	});

	it("should not treat an init.meta.json directory as a class descriptor", () => {
		expect.assertions(2);

		const memory = seed({
			[path.join(ASSETS, "src/Child/init.meta.json/value.luau")]: "return 1",
		});
		const readFile = vi.spyOn(memory.fileSystem, "readFileSync");

		expect(scan(memory, { stage: directoryStage(path.join(ASSETS, "src")) })).toBeEmpty();
		expect(readFile).not.toHaveBeenCalled();
	});

	it.for([
		["at the mount root", "src/init.meta.json", "src/value.luau", 1],
		["in a nested directory", "src/Child/init.meta.json", "src/Child/value.luau", 2],
	] as const)(
		"should read non-pinned metadata %s only while classifying it",
		([, meta, value, reads]) => {
			expect.assertions(3);

			const metaPath = path.join(ASSETS, meta);
			const memory = seed({
				[metaPath]: '{"className":"Folder"}',
				[path.join(ASSETS, value)]: "return 1",
			});
			const readFile = vi.spyOn(memory.fileSystem, "readFileSync");

			expect(scan(memory, { stage: directoryStage(path.join(ASSETS, "src")) })).toBeEmpty();
			expect(readFile).toHaveBeenCalledTimes(reads);
			expect(readFile).toHaveBeenCalledWith(posixPath(metaPath), "utf-8");
		},
	);

	it("should scan a shared mount path once", () => {
		expect.assertions(1);

		const shared = path.join(ASSETS, "StarterPlayerScripts.rbxmx");
		const memory = seed({
			[shared]:
				'<roblox version="4"><Item class="StarterPlayerScripts" referent="0"></Item></roblox>',
		});
		const stage = {
			pkg: { $className: "Folder", First: { $path: shared }, Second: { $path: shared } },
		};

		expect(scan(memory, { stage })).toHaveLength(1);
	});

	it("should not recurse into reserved dollar-prefixed metadata nodes", () => {
		expect.assertions(1);

		const model = path.join(ASSETS, "Terrain.rbxmx");
		const stage = { pkg: { $className: "Folder", $metadata: { $path: model } } };

		expect(scan(seed({ [model]: TERRAIN_XML }), { stage })).toBeEmpty();
	});
});
