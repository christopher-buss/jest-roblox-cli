import { loadLuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixPath } from "#test/mocks/posix-path.ts";
import { createReaderCache } from "./module-dependencies.ts";

const ROOT = path.resolve("/project");

function at(relativePath: string): string {
	return path.join(ROOT, relativePath);
}

const PROJECT = JSON.stringify({
	name: "game",
	tree: { $className: "DataModel", ReplicatedStorage: { shared: { $path: "src" } } },
});

function readerCache(
	files: Record<string, string>,
	relatedFiles: Array<string> = [],
): ReturnType<typeof createReaderCache> {
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(Object.entries(files).map(([file, source]) => [at(file), source])),
	);
	return createReaderCache({
		fileSystem,
		parser: loadLuauParser(),
		relatedKeys: relatedFiles.map((file) => posixPath(at(file))),
	});
}

describe(createReaderCache, () => {
	it("should follow a string require and an instance require through the Rojo project", () => {
		expect.assertions(1);

		const readerOf = readerCache({
			"default.project.json": PROJECT,
			"src/a.luau": 'require("./b")\nreturn require(script.Parent.c)',
			"src/b.luau": "return {}",
			"src/c.luau": "return {}",
		});

		const read = readerOf(at("default.project.json"))(at("src/a.luau"));

		expect({
			dependencies: Array.from(read.dependencies, (file) => path.resolve(file)).sort(),
			isOpen: read.isOpen,
		}).toStrictEqual({ dependencies: [at("src/b.luau"), at("src/c.luau")], isOpen: false });
	});

	it("should open a module whose instance require has no Rojo project to resolve through", () => {
		expect.assertions(1);

		const readerOf = readerCache({ "src/a.luau": "return require(script.Parent.c)" });

		expect(readerOf(undefined)(at("src/a.luau")).isOpen).toBeTrue();
	});

	it("should read a related module gone from disk as one with no requires", () => {
		expect.assertions(1);

		const readerOf = readerCache({}, ["src/gone.luau"]);

		expect(readerOf(undefined)(at("src/gone.luau"))).toStrictEqual({
			dependencies: new Set(),
			isOpen: false,
		});
	});

	it("should reuse the reader of a Rojo project", () => {
		expect.assertions(1);

		const readerOf = readerCache({});

		expect(readerOf(undefined)).toBe(readerOf(undefined));
	});
});
