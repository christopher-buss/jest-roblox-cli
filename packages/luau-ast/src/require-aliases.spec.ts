import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { memoryFileSystem } from "#test/helpers/unit/file-system";
import { fixtureCstParser } from "#test/helpers/unit/trees";
import type { LuauParser } from "./parser.ts";
import { createAliasLookup } from "./require-aliases.ts";

const ALIASES =
	'return { luau = { aliases = { Shared = "./shared", ["Deep-Lib"] = "lib/deep", abs = "/abs/root" } } }\n';

function lookupOver(files: Record<string, string>) {
	const { fileSystem, volume } = memoryFileSystem(files);
	return { lookup: createAliasLookup({ fileSystem, parser: fixtureCstParser() }), volume };
}

describe(createAliasLookup, () => {
	it.for<[string, string]>([
		["shared", "/project/shared"],
		["DEEP-lib", "/project/lib/deep"],
		["abs", "/abs/root"],
	])("should find %s in .config.luau relative to its folder", ([name, target]) => {
		expect.assertions(1);

		const { lookup } = lookupOver({ "/project/.config.luau": ALIASES });

		expect(lookup({ name, directory: "/project/src" })).toStrictEqual({
			kind: "found",
			path: target,
		});
	});

	it("should read the table that .config.luau returns after other statements", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/project/.config.luau":
				'local x = 1\nreturn { luau = { aliases = { shared = "./shared" } } }\n',
		});

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "found",
			path: "/project/shared",
		});
	});

	it("should report a folder that holds both .config.luau and .luaurc", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/project/.config.luau": ALIASES,
			"/project/.luaurc": '{ "aliases": { "pkg": "../packages/pkg" } }',
		});

		expect(lookup({ name: "pkg", directory: "/project/src" })).toStrictEqual({
			kind: "invalid",
			reason: "/project holds both .config.luau and .luaurc, so its aliases are ambiguous",
		});
	});

	it("should find an alias before it reaches an ambiguous folder", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/.config.luau": ALIASES,
			"/.luaurc": "{}",
			"/project/.luaurc": '{ "aliases": { "pkg": "../packages/pkg" } }',
		});

		expect(lookup({ name: "pkg", directory: "/project" })).toStrictEqual({
			kind: "found",
			path: "/packages/pkg",
		});
	});

	it("should go on to the parent folder when the nearer configuration lacks the alias", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/project/.config.luau": ALIASES,
			"/project/src/.luaurc": '{ "aliases": { "pkg": "../packages/pkg" } }',
		});

		expect(lookup({ name: "shared", directory: "/project/src" })).toStrictEqual({
			kind: "found",
			path: "/project/shared",
		});
	});

	it("should prefer the nearest folder's configuration", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/project/.config.luau": ALIASES,
			"/project/src/.luaurc": '{ "aliases": { "shared": "./near" } }',
		});

		expect(lookup({ name: "shared", directory: "/project/src" })).toStrictEqual({
			kind: "found",
			path: "/project/src/near",
		});
	});

	it("should report an alias that no configuration names", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({ "/project/.luaurc": "{}" });

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "missing",
		});
	});

	it.for(["return { [1] = 2 }\n", "return { luau = {} }\n"])(
		"should find no aliases in %j",
		(source) => {
			expect.assertions(1);

			const { lookup } = lookupOver({ "/project/.config.luau": source });

			expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
				kind: "missing",
			});
		},
	);

	it.for([
		"return { luau = { aliases = { shared = makePath() } } }\n",
		"return { luau = 1 }\n",
		"return { luau = { aliases = 1 } }\n",
		'return { luau = { aliases = { "positional" } } }\n',
		"local x = 1\n",
		"return 1\n",
		"return\n",
	])("should report a .config.luau that builds its aliases with code: %j", (source) => {
		expect.assertions(1);

		const { lookup } = lookupOver({ "/project/.config.luau": source });

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "invalid",
			reason: "/project/.config.luau does not hold luau.aliases as a table of strings",
		});
	});

	it("should report a .config.luau that does not parse", () => {
		expect.assertions(1);

		const { fileSystem } = memoryFileSystem({ "/project/.config.luau": "return {\n" });
		const parser = fromPartial<LuauParser>({
			parseCst: () => ({ errors: ["Expected identifier", "Expected end"], ok: false }),
		});
		const lookup = createAliasLookup({ fileSystem, parser });

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "invalid",
			reason: "/project/.config.luau does not parse: Expected identifier; Expected end",
		});
	});

	it("should restate a backslash in an alias path as a forward slash", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({
			"/project/.luaurc": String.raw`{ "aliases": { "deep": "lib\\deep" } }`,
		});

		expect(lookup({ name: "deep", directory: "/project" })).toStrictEqual({
			kind: "found",
			path: "/project/lib/deep",
		});
	});

	it.for(['{ "aliases": ', '{ "aliases": { "shared": 1 } }'])(
		"should report a .luaurc it cannot read: %j",
		(source) => {
			expect.assertions(1);

			const { lookup } = lookupOver({ "/project/.luaurc": source });

			expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
				kind: "invalid",
				reason: expect.stringMatching(/^\/project\/\.luaurc is not a valid \.luaurc: /),
			});
		},
	);

	it("should report a configuration path that is a folder", () => {
		expect.assertions(1);

		const { lookup } = lookupOver({ "/project/.luaurc/inner": "" });

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "invalid",
			reason: expect.stringMatching(/^\/project\/\.luaurc cannot be read: .*EISDIR/),
		});
	});

	it("should report a read that throws a value other than an Error", () => {
		expect.assertions(1);

		const lookup = createAliasLookup({
			fileSystem: {
				existsSync: (filePath) => filePath === "/project/.luaurc",
				readFileSync: () => {
					// oxlint-disable-next-line typescript/only-throw-error -- exercises the non-Error normalization
					throw "denied";
				},
			},
			parser: fixtureCstParser(),
		});

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "invalid",
			reason: "/project/.luaurc cannot be read: denied",
		});
	});

	it("should read each configuration file once", () => {
		expect.assertions(1);

		const { lookup, volume } = lookupOver({ "/project/.luaurc": '{ "aliases": {} }' });
		lookup({ name: "shared", directory: "/project" });
		volume.writeFileSync("/project/.luaurc", '{ "aliases": { "shared": "./shared" } }');
		volume.writeFileSync("/.luaurc", "{}");

		expect(lookup({ name: "shared", directory: "/project" })).toStrictEqual({
			kind: "missing",
		});
	});
});
