import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { aliasVersionWarning, formatSetupOutcome, runSetup } from "./setup.ts";

const HOME = path.resolve("/home/user");
const PROJECT = path.resolve("/project");
const TYPES_DIRECTORY = path.join(HOME, ".jest-roblox", "typedefs", "1.2.3");
const ALIAS_LINE = '["jest-roblox"] = "~/.jest-roblox/typedefs/1.2.3"';

function setup(seed: Record<string, string> = {}) {
	const files = Object.fromEntries(
		Object.entries(seed).map(([name, contents]) => [path.join(PROJECT, name), contents]),
	);
	const { fileSystem, volume } = createMemoryFileSystem(files);
	volume.mkdirSync(PROJECT, { recursive: true });
	const outcome = runSetup({ cwd: PROJECT, fileSystem, homeDirectory: HOME, version: "1.2.3" });
	return {
		exists: (name: string) => volume.existsSync(path.join(PROJECT, name)),
		outcome,
		read: (name: string) => volume.readFileSync(path.join(PROJECT, name), "utf-8"),
		volume,
	};
}

describe(runSetup, () => {
	it("should write the type module to the versioned home folder", () => {
		expect.assertions(1);

		const { volume } = setup();

		expect(volume.readFileSync(path.join(TYPES_DIRECTORY, "config.luau"), "utf-8")).toContain(
			"export type Config =",
		);
	});

	it("should create .config.luau when the project has no Luau configuration", () => {
		expect.assertions(2);

		const { outcome, read } = setup();

		expect(outcome).toStrictEqual({
			configFile: ".config.luau",
			kind: "created",
			typesDirectory: TYPES_DIRECTORY,
		});
		expect(read(".config.luau")).toBe(
			`return {\n\tluau = {\n\t\taliases = {\n\t\t\t${ALIAS_LINE},\n\t\t},\n\t},\n}\n`,
		);
	});

	it("should add the alias to an existing .config.luau and keep its comments", () => {
		expect.assertions(2);

		const { outcome, read } = setup({
			".config.luau":
				'-- settings\nreturn {\n\tluau = {\n\t\taliases = {\n\t\t\tshared = "./shared", -- shared\n\t\t},\n\t},\n}\n',
		});

		expect(outcome.kind).toBe("edited");
		expect(read(".config.luau")).toBe(
			`-- settings\nreturn {\n\tluau = {\n\t\taliases = {\n\t\t\tshared = "./shared", -- shared\n\t\t\t${ALIAS_LINE},\n\t\t},\n\t},\n}\n`,
		);
	});

	it("should leave a .config.luau that builds its aliases with code and name the entry", () => {
		expect.assertions(2);

		const source = "local aliases = {}\nreturn { luau = { aliases = aliases } }\n";
		const { outcome, read } = setup({ ".config.luau": source });

		expect(outcome).toStrictEqual({
			configFile: ".config.luau",
			entry: ALIAS_LINE,
			kind: "manual",
			typesDirectory: TYPES_DIRECTORY,
		});
		expect(read(".config.luau")).toBe(source);
	});

	it("should merge the alias into a .luaurc and keep its other keys", () => {
		expect.assertions(3);

		const { exists, outcome, read } = setup({
			".luaurc":
				'{\n  "languageMode": "strict",\n  "aliases": { "shared": "./shared", "JEST-ROBLOX": "old" }\n}\n',
		});

		expect(outcome).toStrictEqual({
			configFile: ".luaurc",
			kind: "edited",
			typesDirectory: TYPES_DIRECTORY,
		});
		expect(read(".luaurc")).toBe(
			'{\n  "languageMode": "strict",\n  "aliases": {\n    "shared": "./shared",\n    "jest-roblox": "~/.jest-roblox/typedefs/1.2.3"\n  }\n}\n',
		);
		expect(exists(".config.luau")).toBeFalse();
	});

	it("should add an aliases object to a .luaurc without one", () => {
		expect.assertions(1);

		const { read } = setup({ ".luaurc": '{"languageMode":"strict"}' });

		expect(read(".luaurc")).toBe(
			'{\n\t"languageMode": "strict",\n\t"aliases": {\n\t\t"jest-roblox": "~/.jest-roblox/typedefs/1.2.3"\n\t}\n}\n',
		);
	});

	it("should leave a .luaurc with a comment unchanged and name the entry to add", () => {
		expect.assertions(3);

		const source = '{\n\t-- strict everywhere\n\t"languageMode": "strict",\n}\n';
		const { exists, outcome, read } = setup({ ".luaurc": source });

		expect(outcome).toStrictEqual({
			configFile: ".luaurc",
			entry: '"jest-roblox": "~/.jest-roblox/typedefs/1.2.3"',
			kind: "unreadable",
			problem: expect.stringMatching(
				/^it is not strict JSON \(.+\)\. Setup cannot read comments or trailing commas$/,
			),
			typesDirectory: TYPES_DIRECTORY,
		});
		expect(read(".luaurc")).toBe(source);
		expect(exists(".config.luau")).toBeFalse();
	});

	it("should name the key of a .luaurc whose aliases are not strings", () => {
		expect.assertions(2);

		const source = '{ "aliases": { "x": 1 } }';
		const { outcome, read } = setup({ ".luaurc": source });

		expect(outcome).toStrictEqual({
			configFile: ".luaurc",
			entry: '"jest-roblox": "~/.jest-roblox/typedefs/1.2.3"',
			kind: "unreadable",
			problem: "aliases.x must be a string (was a number)",
			typesDirectory: TYPES_DIRECTORY,
		});
		expect(read(".luaurc")).toBe(source);
	});
});

describe(formatSetupOutcome, () => {
	it("should say which file got the alias", () => {
		expect.assertions(2);

		expect(
			formatSetupOutcome({ configFile: ".luaurc", kind: "edited", typesDirectory: "/types" }),
		).toBe(
			'Wrote the Luau Config type to /types\nUpdated .luaurc with the "jest-roblox" alias\nType your config with: local jest = require("@jest-roblox/config")\n',
		);
		expect(
			formatSetupOutcome({
				configFile: ".config.luau",
				kind: "created",
				typesDirectory: "/types",
			}),
		).toContain('\nCreated .config.luau with the "jest-roblox" alias\n');
	});

	it("should print the exact entry to add by hand", () => {
		expect.assertions(1);

		expect(
			formatSetupOutcome({
				configFile: ".config.luau",
				entry: ALIAS_LINE,
				kind: "manual",
				typesDirectory: "/types",
			}),
		).toBe(
			`Wrote the Luau Config type to /types\n.config.luau builds luau.aliases with code, so setup left it unchanged.\nAdd this entry to luau.aliases:\n\n\t${ALIAS_LINE},\n\nType your config with: local jest = require("@jest-roblox/config")\n`,
		);
	});
});

describe(aliasVersionWarning, () => {
	function warn(seed: Record<string, string>) {
		const files = Object.fromEntries(
			Object.entries(seed).map(([name, contents]) => [path.join(PROJECT, name), contents]),
		);
		const { fileSystem, volume } = createMemoryFileSystem(files);
		volume.mkdirSync(PROJECT, { recursive: true });
		return aliasVersionWarning({ cwd: PROJECT, fileSystem, version: "1.2.3" });
	}

	it.for([
		[
			".config.luau",
			'return { luau = { aliases = { ["jest-roblox"] = "~/.jest-roblox/typedefs/1.0.0" } } }',
		],
		[".luaurc", '{ "aliases": { "Jest-Roblox": "~/.jest-roblox/typedefs/1.0.0/" } }'],
	] as const)(
		"should name both versions and say to run setup for an alias in %s",
		([file, source]) => {
			expect.assertions(1);

			expect(warn({ [file]: source })).toBe(
				`Warning: the "jest-roblox" alias in ${file} points at the Luau Config type for jest-roblox 1.0.0, but this is jest-roblox 1.2.3. Run \`jest-roblox setup\` to update it.\n`,
			);
		},
	);

	it("should read an alias written as an absolute Windows path", () => {
		expect.assertions(1);

		expect(
			warn({
				".luaurc": JSON.stringify({
					aliases: { "jest-roblox": String.raw`C:\Users\me\.jest-roblox\typedefs\0.9.0` },
				}),
			}),
		).toContain("for jest-roblox 0.9.0,");
	});

	it.for([
		[
			"the alias matches",
			{ ".luaurc": '{ "aliases": { "jest-roblox": "~/.jest-roblox/typedefs/1.2.3" } }' },
		],
		["the project has no Luau configuration", {}],
		["the .luaurc has no aliases", { ".luaurc": '{ "languageMode": "strict" }' }],
		[
			"another alias points at another version",
			{ ".luaurc": '{ "aliases": { "old": "~/.jest-roblox/typedefs/1.0.0" } }' },
		],
		["the .luaurc is not strict JSON", { ".luaurc": '{ "aliases": {}, }' }],
		[
			"the alias points elsewhere",
			{ ".luaurc": '{ "aliases": { "jest-roblox": "./types" } }' },
		],
		["the .config.luau has no alias", { ".config.luau": "return {}" }],
		[
			"a .config.luau without the alias sits beside an old .luaurc",
			{
				".config.luau": "return {}",
				".luaurc": '{ "aliases": { "jest-roblox": "~/.jest-roblox/typedefs/1.0.0" } }',
			},
		],
	] as const)("should not warn when %s", ([, seed]) => {
		expect.assertions(1);

		expect(warn(seed)).toBeUndefined();
	});

	it.for([".config.luau", ".luaurc"])("should not warn when %s cannot be read", (file) => {
		expect.assertions(1);

		const { fileSystem, volume } = createMemoryFileSystem();
		volume.mkdirSync(path.join(PROJECT, file), { recursive: true });

		expect(aliasVersionWarning({ cwd: PROJECT, fileSystem, version: "1.2.3" })).toBeUndefined();
	});
});
