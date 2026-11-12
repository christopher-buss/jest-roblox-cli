import { loadLuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import type { ChangeScope } from "./change-scope.ts";
import { createRelatedFileFilter } from "./related-tests.ts";

const WORKSPACE = path.resolve("/workspace");
const ROOT = path.join(WORKSPACE, "project");

function at(relativePath: string): string {
	return path.join(ROOT, relativePath);
}

function selectRelated({
	files,
	forceRerunTriggers = [],
	relatedFiles,
	rojoRoots = [ROOT],
	scoped = true,
	testFiles,
}: {
	files: Record<string, string>;
	forceRerunTriggers?: Array<string>;
	relatedFiles: Array<string>;
	rojoRoots?: Array<string>;
	scoped?: boolean;
	testFiles: Array<string>;
}): Array<string> {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(Object.entries(files).map(([file, source]) => [at(file), source])),
	);
	const filter = createRelatedFileFilter({
		fileSystem,
		parser: loadLuauParser(),
		relatedFiles: relatedFiles.map(at),
		scope: scoped
			? {
					forceRerunTriggers,
					projectRoot: posixPath(ROOT),
					rojoRoots: rojoRoots.map(posixPath),
					workspaceRoot: posixPath(WORKSPACE),
				}
			: undefined,
		timing: clockTimingCollector(),
	});
	return filter(testFiles, ROOT);
}

function wholeProjectScope(): ChangeScope {
	return {
		forceRerunTriggers: [],
		projectRoot: ROOT,
		rojoRoots: [ROOT],
		workspaceRoot: ROOT,
	};
}

describe(createRelatedFileFilter, () => {
	it("should select a test file that is itself a related file", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil", "b.spec.luau": "return nil" },
			relatedFiles: ["a.spec.luau"],
			testFiles: ["a.spec.luau", "b.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.luau"]);
	});

	it("should select a test that reaches a related file through two string requires", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"leaf.luau": "return {}",
				"middle.luau": 'return require("./leaf")',
				"other.spec.luau": "return nil",
				"top.spec.luau": 'local middle = require("./middle")\nreturn nil',
			},
			relatedFiles: ["leaf.luau"],
			testFiles: ["top.spec.luau", "other.spec.luau"],
		});

		expect(selected).toStrictEqual(["top.spec.luau"]);
	});

	it("should select every test that reaches a shared module", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"a.spec.luau": 'return require("./shared")',
				"b.spec.luau": 'return require("./shared")',
				"shared.luau": "return {}",
			},
			relatedFiles: ["shared.luau"],
			testFiles: ["a.spec.luau", "b.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.luau", "b.spec.luau"]);
	});

	it("should follow a require that resolves to a folder init file", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"lib.spec.luau": 'return require("./lib")',
				"lib/init.luau": 'return require("@self/util")',
				"lib/util.luau": "return {}",
			},
			relatedFiles: [path.join("lib", "util.luau")],
			testFiles: ["lib.spec.luau"],
		});

		expect(selected).toStrictEqual(["lib.spec.luau"]);
	});

	it.for([true, false])(
		"should select every test that required a deleted related module (scoped: %s)",
		(scoped) => {
			expect.assertions(1);

			const selected = selectRelated({
				files: {
					".luaurc": '{ "aliases": { "root": "." } }',
					"a.spec.luau": 'return require("./gone")',
					"b.spec.luau": 'return require("./lib")',
					"c.spec.luau": 'return require("@root/kept")',
					"kept.luau": "return {}",
					"lib/init.luau": 'return require("@self/removed")',
				},
				relatedFiles: ["gone.luau", path.join("lib", "removed.lua")],
				scoped,
				testFiles: ["a.spec.luau", "b.spec.luau", "c.spec.luau"],
			});

			expect(selected).toStrictEqual(["a.spec.luau", "b.spec.luau"]);
		},
	);

	it.for([true, false])(
		"should select every test that required a module renamed to another form (scoped: %s)",
		(scoped) => {
			expect.assertions(1);

			const selected = selectRelated({
				files: {
					"a.spec.luau": 'return require("./x")',
					"b.spec.luau": 'return require("./y")',
					"x.luau": "return {}",
					"y/init.luau": "return {}",
				},
				relatedFiles: ["x.lua", "x.luau", "y.luau", path.join("y", "init.luau")],
				scoped,
				testFiles: ["a.spec.luau", "b.spec.luau"],
			});

			expect(selected).toStrictEqual(["a.spec.luau", "b.spec.luau"]);
		},
	);

	it.for([true, false])(
		"should keep a deleted alias config from hiding the config beside it (scoped: %s)",
		(scoped) => {
			expect.assertions(1);

			const selected = selectRelated({
				files: {
					"luau/.config.luau": 'return { luau = { aliases = { root = "." } } }',
					"luau/b.spec.luau": 'return require("@root/target")',
					"luau/target.luau": "return {}",
					"rc/.luaurc": '{ "aliases": { "root": "." } }',
					"rc/a.spec.luau": 'return require("@root/target")',
					"rc/target.luau": "return {}",
				},
				relatedFiles: [
					path.join("rc", ".config.luau"),
					path.join("rc", "target.luau"),
					path.join("luau", ".luaurc"),
					path.join("luau", "target.luau"),
				],
				scoped,
				testFiles: [path.join("rc", "a.spec.luau"), path.join("luau", "b.spec.luau")],
			});

			expect(selected).toStrictEqual([
				path.join("rc", "a.spec.luau"),
				path.join("luau", "b.spec.luau"),
			]);
		},
	);

	it("should select nothing for a related file no test reaches", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil", "lonely.luau": "return {}" },
			relatedFiles: ["lonely.luau"],
			testFiles: ["a.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
	});

	it.for<[string, string]>([
		["a require it cannot resolve", 'return require("./nowhere")'],
		["a dynamic require", 'local name = "x"\nreturn require(name)'],
		["an instance-path require", "return require(script.Parent.target)"],
		["a module it cannot parse", "local = "],
	])("should select every test when the graph holds %s", ([, source]) => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"open.spec.luau": source,
				"other.spec.luau": "return nil",
				"target.luau": "return {}",
			},
			relatedFiles: ["target.luau"],
			testFiles: ["open.spec.luau", "other.spec.luau"],
		});

		expect(selected).toStrictEqual(["open.spec.luau", "other.spec.luau"]);
	});

	it("should select every test when a test file is not Luau or does not exist", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.ts": 'require("./target")', "target.luau": "return {}" },
			relatedFiles: ["target.luau"],
			testFiles: ["a.spec.ts", "missing.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.ts", "missing.spec.luau"]);
	});

	it("should walk from every related file and never widen without a scope", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[at("a.spec.luau")]: 'require("./target")\nrequire(script.Parent.other)',
			[at("b.spec.luau")]: "return nil",
			[at("target.luau")]: "return {}",
		});
		const filter = createRelatedFileFilter({
			fileSystem,
			parser: loadLuauParser(),
			relatedFiles: [at("target.luau"), path.join(WORKSPACE, "elsewhere.md")],
			timing: clockTimingCollector(),
		});

		expect(filter(["a.spec.luau", "b.spec.luau"], ROOT)).toStrictEqual(["a.spec.luau"]);
	});

	it("should select nothing from an open graph when no related file is in scope", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "open.spec.luau": 'return require("./nowhere")' },
			relatedFiles: [path.join("..", "elsewhere", "file.luau")],
			testFiles: ["open.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
	});

	it.for<[string, string]>([
		["a file in the project root outside the Rojo tree", "jest.config.luau"],
		["a file in the Rojo tree that is not Luau", path.join("src", "data.json")],
		["a Luau script in the Rojo tree", path.join("src", "boot.server.luau")],
	])("should select every test for %s", ([, relatedFile]) => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"src/a.spec.luau": "return nil",
				"src/b.spec.luau": "return nil",
			},
			relatedFiles: [relatedFile],
			rojoRoots: [at("src")],
			testFiles: ["src/a.spec.luau", "src/b.spec.luau"],
		});

		expect(selected).toStrictEqual(["src/a.spec.luau", "src/b.spec.luau"]);
	});

	it("should select every test for a file in a Rojo mount outside the project root", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil" },
			relatedFiles: [path.join("..", "assets", "model.rbxm")],
			rojoRoots: [ROOT, path.join(WORKSPACE, "assets")],
			testFiles: ["a.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.luau"]);
	});

	it("should select every test for a file that matches a trigger relative to the workspace root", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil" },
			forceRerunTriggers: ["pnpm-lock.yaml"],
			relatedFiles: [path.join("..", "pnpm-lock.yaml")],
			testFiles: ["a.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.luau"]);
	});

	it("should ignore a file outside the project root, the Rojo tree and the triggers", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil" },
			forceRerunTriggers: ["pnpm-lock.yaml"],
			relatedFiles: [path.join("..", "other", "pnpm-lock.yaml")],
			testFiles: ["a.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
	});

	it("should follow a module outside the scope that a test reaches", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"../shared/util.luau": "return {}",
				"a.spec.luau": 'return require("../shared/util")',
				"b.spec.luau": "return nil",
			},
			relatedFiles: [path.join("..", "shared", "util.luau")],
			testFiles: ["a.spec.luau", "b.spec.luau"],
		});

		expect(selected).toStrictEqual(["a.spec.luau"]);
	});

	it("should follow a module in the project root outside the Rojo tree that a test reaches", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"helpers/util.luau": "return {}",
				"src/a.spec.luau": 'return require("../helpers/util")',
				"src/b.spec.luau": "return nil",
			},
			relatedFiles: [path.join("helpers", "util.luau")],
			rojoRoots: [at("src")],
			testFiles: ["src/a.spec.luau", "src/b.spec.luau"],
		});

		expect(selected).toStrictEqual(["src/a.spec.luau"]);
	});

	it("should keep selecting through a require cycle", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"a.luau": 'return require("./b")',
				"b.luau": 'return require("./a")',
				"cycle.spec.luau": 'return require("./a")',
			},
			relatedFiles: ["b.luau"],
			testFiles: ["cycle.spec.luau"],
		});

		expect(selected).toStrictEqual(["cycle.spec.luau"]);
	});

	it("should select across calls with the graph build in a profiled phase", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem({
			[at("a.spec.luau")]: 'return require("./shared")',
			[at("b.spec.luau")]: 'return require("./shared")',
			[at("shared.luau")]: "return {}",
		});
		const timing = clockTimingCollector();
		const profile = vi.spyOn(timing, "profile");
		const filter = createRelatedFileFilter({
			fileSystem,
			parser: loadLuauParser(),
			relatedFiles: [at("shared.luau")],
			scope: wholeProjectScope(),
			timing,
		});

		const selected = [...filter(["a.spec.luau"], ROOT), ...filter([at("b.spec.luau")], ROOT)];

		expect(selected).toStrictEqual(["a.spec.luau", at("b.spec.luau")]);
		expect(profile).toHaveBeenCalledWith("buildDependencyGraph", expect.any(Function));
	});

	it("should keep the requires of a module read in an earlier call", () => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem({
			[at("a.spec.luau")]: 'return require("./shared")',
			[at("b.spec.luau")]: 'return require("./shared")',
			[at("shared.luau")]: "return {}",
			[at("target.luau")]: "return {}",
		});
		const filter = createRelatedFileFilter({
			fileSystem,
			parser: loadLuauParser(),
			relatedFiles: [at("target.luau")],
			scope: wholeProjectScope(),
			timing: clockTimingCollector(),
		});

		filter(["a.spec.luau"], ROOT);
		volume.writeFileSync(at("shared.luau"), 'return require("./target")');

		expect(filter(["b.spec.luau"], ROOT)).toStrictEqual([]);
	});
});
