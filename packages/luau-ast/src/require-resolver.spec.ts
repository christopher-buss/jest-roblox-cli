import { describe, expect, it } from "vitest";

import { memoryFileSystem } from "#test/helpers/unit/file-system";
import { fixtureCstParser } from "#test/helpers/unit/trees";
import { createStringRequireResolver } from "./require-resolver.ts";
import type { StringRequireResolution, StringRequireResolver } from "./require-resolver.ts";

const ALIASES =
	'return { luau = { aliases = { Shared = "./shared", ["Deep-Lib"] = "lib/deep", abs = "/abs/root" } } }\n';

function resolverOver(files: Record<string, string>) {
	const parser = fixtureCstParser();
	const { fileSystem, volume } = memoryFileSystem(files);
	return { resolve: createStringRequireResolver({ fileSystem, parser }), volume };
}

function existing(...paths: ReadonlyArray<string>): StringRequireResolver {
	return resolverOver(Object.fromEntries(paths.map((filePath) => [filePath, ""]))).resolve;
}

function unresolved(reason: string): StringRequireResolution {
	return { kind: "unresolved", reason };
}

describe(createStringRequireResolver, () => {
	it.for<[string, string, string]>([
		["/luau/runner.luau", "./helper", "/luau/helper.luau"],
		["/luau/runner.luau", "./legacy", "/luau/legacy.lua"],
		["/luau/staging/entry.luau", "../helper", "/luau/helper.luau"],
		["/luau/runner.luau", "./mock/Service", "/luau/mock/Service.luau"],
		["/luau/runner.luau", "./helper/", "/luau/helper.luau"],
		["/luau/a/b/caller.luau", "../../helper", "/luau/helper.luau"],
		["/luau/a/b/caller.luau", "..//../helper", "/luau/helper.luau"],
		["/luau/runner.luau", "./surface", "/luau/surface/init.luau"],
		["/luau/runner.luau", "./classic", "/luau/classic/init.lua"],
		["/luau/surface/init.luau", "./helper", "/luau/helper.luau"],
		["/luau/surface/init.luau", "@self/realm", "/luau/surface/realm.luau"],
		["/luau/surface/init.luau", "@self/nested", "/luau/surface/nested/init.luau"],
		["/luau/surface/init.lua", "../helper", "/helper.luau"],
	])("should resolve %s requiring %j", ([from, request, target]) => {
		expect.assertions(1);

		const resolve = existing(
			"/helper.luau",
			"/luau/helper.luau",
			"/luau/legacy.lua",
			"/luau/mock/Service.luau",
			"/luau/surface/init.luau",
			"/luau/surface/realm.luau",
			"/luau/surface/nested/init.luau",
			"/luau/classic/init.lua",
		);

		expect(resolve(from, request)).toStrictEqual({ kind: "resolved", path: target });
	});

	it.for<[string, string]>([
		["@shared/util", "/project/shared/util.luau"],
		["@Deep-Lib", "/project/lib/deep/init.luau"],
		["@abs/x", "/abs/root/x.luau"],
		["@pkg/x", "/packages/pkg/x.luau"],
	])("should resolve the alias require %j", ([request, target]) => {
		expect.assertions(1);

		const { resolve } = resolverOver({
			"/abs/root/x.luau": "",
			"/packages/pkg/x.luau": "",
			"/project/.config.luau": ALIASES,
			"/project/lib/deep/init.luau": "",
			"/project/shared/util.luau": "",
			"/project/src/.luaurc": '{ "aliases": { "pkg": "../../packages/pkg" } }',
		});

		expect(resolve("/project/src/a.luau", request)).toStrictEqual({
			kind: "resolved",
			path: target,
		});
	});

	it.for<[string, string]>([
		["./foo/.", "'.' is only allowed at the beginning of a require path"],
		["./../helper", "'..' is only allowed at the beginning of a require path"],
		["./foo/../helper", "'..' is only allowed at the beginning of a require path"],
		["./foo/@self", "'@self' is only allowed at the beginning of a require path"],
		["/abs/path", "paths beginning with '/' are not supported (from /luau/runner.luau)"],
		[
			"helper",
			'bare require("helper") is not supported; use a relative path (from /luau/runner.luau)',
		],
		[
			"@self/helper",
			"@self requires are only valid from init.luau / init.lua (from /luau/runner.luau)",
		],
		[
			"@missing/helper",
			"@missing is not an alias in any .config.luau or .luaurc (from /luau/runner.luau)",
		],
		[
			"./missing",
			'cannot resolve require("./missing") from /luau/runner.luau: no module at /luau/missing (tried .luau, .lua, /init.luau, /init.lua)',
		],
		[
			"./surface",
			'cannot resolve require("./surface") from /luau/runner.luau: ambiguous between /luau/surface.luau and /luau/surface/init.luau',
		],
		[
			"./both",
			'cannot resolve require("./both") from /luau/runner.luau: ambiguous between /luau/both.luau and /luau/both.lua',
		],
	])("should not resolve %j", ([request, reason]) => {
		expect.assertions(1);

		const resolve = existing(
			"/luau/helper.luau",
			"/luau/surface.luau",
			"/luau/surface/init.luau",
			"/luau/both.luau",
			"/luau/both.lua",
		);

		expect(resolve("/luau/runner.luau", request)).toStrictEqual(unresolved(reason));
	});

	it.for<[string, string]>([
		["/luau/surface/init.luau", "@self/../helper"],
		["/project/src/a.luau", "@shared/../helper"],
	])("should not walk out of where %s starts %j", ([from, request]) => {
		expect.assertions(1);

		const { resolve } = resolverOver({
			"/luau/helper.luau": "",
			"/project/.config.luau": ALIASES,
			"/project/helper.luau": "",
		});

		expect(resolve(from, request)).toStrictEqual(
			unresolved("'..' is only allowed at the beginning of a require path"),
		);
	});

	it("should pass on why an alias configuration cannot be read", () => {
		expect.assertions(1);

		const { resolve } = resolverOver({ "/luau/.luaurc": "[" });

		expect(resolve("/luau/runner.luau", "@shared/x")).toStrictEqual({
			kind: "unresolved",
			reason: expect.stringMatching(/^\/luau\/\.luaurc is not a valid \.luaurc: /),
		});
	});

	it("should cache a probe even when the missing module appears later", () => {
		expect.assertions(2);

		const { resolve, volume } = resolverOver({ "/luau/runner.luau": "" });

		expect(resolve("/luau/runner.luau", "./late")).toMatchObject({ kind: "unresolved" });

		volume.writeFileSync("/luau/late.luau", "");

		expect(resolve("/luau/runner.luau", "./late")).toMatchObject({ kind: "unresolved" });
	});
});
