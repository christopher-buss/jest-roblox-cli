import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import type { RootDiscovery } from "./discover-roots.ts";
import { discoverLuauRoots, isLuauFile } from "./discover-roots.ts";

const FRAME = path.resolve("/repo/pkg");

function treeOf(mounts: Array<string>): RojoTreeNode {
	return {
		$className: "DataModel",
		ReplicatedStorage: Object.fromEntries(mounts.map((mount) => [mount, { $path: mount }])),
	};
}

function seed(volume: MemoryVolume, files: Record<string, string>): void {
	for (const [file, content] of Object.entries(files)) {
		const absolute = path.join(FRAME, file);
		volume.mkdirSync(path.dirname(absolute), { recursive: true });
		volume.writeFileSync(absolute, content);
	}
}

function discover(
	files: Record<string, string>,
	{ mounts = [], ...rest }: Partial<RootDiscovery> & { mounts?: Array<string> },
): { result: ReturnType<typeof discoverLuauRoots>; warn: ReturnType<typeof vi.fn> } {
	const { fileSystem, volume } = createMemoryFileSystem();
	seed(volume, files);
	const warn = vi.fn<(text: string) => void>();
	const result = discoverLuauRoots({
		check: { frameName: "rootDir", warn },
		explicit: undefined,
		fileSystem,
		frame: FRAME,
		holdsRoot: isLuauFile,
		isIgnored: () => false,
		rojo: { rojoDirectory: FRAME, tree: treeOf(mounts) },
		...rest,
	});
	return { result, warn };
}

describe(discoverLuauRoots, () => {
	it("should take a mount that holds only .lua source", () => {
		expect.assertions(1);

		const { result } = discover({ "out/init.lua": "" }, { mounts: ["out"] });

		expect(result).toStrictEqual([posixRoot("out")]);
	});

	it("should take a mount that holds only spec files", () => {
		expect.assertions(1);

		const { result } = discover({ "out/a.spec.luau": "" }, { mounts: ["out"] });

		expect(result).toStrictEqual([posixRoot("out")]);
	});

	it("should skip the roblox-ts include directory", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "include/Promise.lua": "", "include/RuntimeLib.lua": "", "out/init.luau": "" },
			{ mounts: ["include", "out"] },
		);

		expect(result).toStrictEqual([posixRoot("out")]);
	});

	it("should answer undefined when there is no rojo project", () => {
		expect.assertions(1);

		const { result } = discover({}, { rojo: undefined });

		expect(result).toBeUndefined();
	});

	it("should take explicit roots verbatim when nothing checks them", () => {
		expect.assertions(1);

		const { result } = discover({}, { check: undefined, explicit: ["./out", "out", "gone"] });

		expect(result).toStrictEqual([posixRoot("out"), posixRoot("gone")]);
	});

	it("should drop an explicit root outside the frame, with a warning", () => {
		expect.assertions(2);

		const { result, warn } = discover({}, { explicit: ["../bar"], mounts: ["out"] });

		expect(result).toStrictEqual([]);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Warning: luauRoot "../bar" is not a directory inside rootDir, so it reports no coverage.\n',
		);
	});

	it("should drop an explicit root no mount reaches, with a warning", () => {
		expect.assertions(2);

		const warn = vi.fn<(text: string) => void>();
		const { result } = discover(
			{ "lib/init.luau": "" },
			{
				check: { frameName: "the package", subject: "@scope/foo", warn },
				explicit: ["lib"],
				mounts: ["out"],
			},
		);

		expect(result).toStrictEqual([]);
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Warning: luauRoot "lib" in @scope/foo does not correspond to any rojo $path mount, so it reports no coverage.\n',
		);
	});

	it("should name the subject when the frame itself is given as a root", () => {
		expect.assertions(1);

		const warn = vi.fn<(text: string) => void>();
		discover(
			{},
			{
				check: { frameName: "the package", subject: "@scope/foo", warn },
				explicit: ["src/.."],
			},
		);

		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Warning: luauRoot "src/.." in @scope/foo is not a directory inside the package, so it reports no coverage.\n',
		);
	});

	it("should skip a mount that holds nothing the caller takes", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "out/a.spec.luau": "" },
			{ holdsRoot: (name) => !name.includes(".spec."), mounts: ["out"] },
		);

		expect(result).toBeUndefined();
	});

	it("should skip a mount that holds no Luau", () => {
		expect.assertions(1);

		const { result } = discover({ "out/a.txt": "" }, { mounts: ["out"] });

		expect(result).toBeUndefined();
	});

	it("should not take the frame itself as a mounted root", () => {
		expect.assertions(1);

		const { result } = discover({ "init.luau": "" }, { mounts: ["."] });

		expect(result).toBeUndefined();
	});

	it("should keep an explicit root above its mounts, deduped by spelling", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "out/client/init.luau": "" },
			{ explicit: ["out", "./out/"], mounts: ["out/client"] },
		);

		expect(result).toStrictEqual([posixRoot("out")]);
	});

	it("should keep an explicit root that holds only spec files", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "src/a.spec.luau": "" },
			{ explicit: ["src"], rojo: undefined },
		);

		expect(result).toStrictEqual([posixRoot("src")]);
	});

	it("should skip the reach check when there is no rojo project", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "out/init.luau": "" },
			{ explicit: ["out"], rojo: undefined },
		);

		expect(result).toStrictEqual([posixRoot("out")]);
	});

	it("should drop an ignored or empty explicit root", () => {
		expect.assertions(1);

		const { result } = discover(
			{ "out/a.txt": "", "vendor/init.luau": "" },
			{
				explicit: ["out", "vendor", "missing", "vendor/init.luau"],
				isIgnored: (relative) => relative === "vendor",
				mounts: ["out", "vendor", "missing", "vendor/init.luau"],
			},
		);

		expect(result).toStrictEqual([]);
	});
});
