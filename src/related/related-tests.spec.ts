import { loadLuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createRelatedFileFilter } from "./related-tests.ts";

const ROOT = path.resolve("/project");

function at(relativePath: string): string {
	return path.join(ROOT, relativePath);
}

function selectRelated({
	files,
	relatedFiles,
	testFiles,
}: {
	files: Record<string, string>;
	relatedFiles: Array<string>;
	testFiles: Array<string>;
}): Array<string> {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(Object.entries(files).map(([file, source]) => [at(file), source])),
	);
	const filter = createRelatedFileFilter({
		fileSystem,
		parser: loadLuauParser(),
		relatedFiles: relatedFiles.map(at),
		timing: clockTimingCollector(),
	});
	return filter(testFiles, ROOT);
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

	it("should select nothing for a related file no test reaches", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.luau": "return nil", "lonely.luau": "return {}" },
			relatedFiles: ["lonely.luau"],
			testFiles: ["a.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
	});

	it("should add no edge for a require it cannot resolve or read", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: {
				"broken.spec.luau": "local = ",
				"dynamic.spec.luau": 'local name = "x"\nreturn require(name)',
				"missing.spec.luau": 'return require("./nowhere")',
				"target.luau": "return {}",
			},
			relatedFiles: ["target.luau"],
			testFiles: ["broken.spec.luau", "dynamic.spec.luau", "missing.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
	});

	it("should read no requires from a test file that is not Luau", () => {
		expect.assertions(1);

		const selected = selectRelated({
			files: { "a.spec.ts": 'require("./target")', "target.luau": "return {}" },
			relatedFiles: ["target.luau"],
			testFiles: ["a.spec.ts", "missing.spec.luau"],
		});

		expect(selected).toStrictEqual([]);
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
			timing: clockTimingCollector(),
		});

		filter(["a.spec.luau"], ROOT);
		volume.writeFileSync(at("shared.luau"), 'return require("./target")');

		expect(filter(["b.spec.luau"], ROOT)).toStrictEqual([]);
	});
});
