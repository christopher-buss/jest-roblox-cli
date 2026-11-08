import { describe, expect, it } from "vitest";

import { lastStatementCall } from "#test/helpers/unit/cst";
import { cstTree } from "#test/helpers/unit/trees";
import type { CstCall } from "./cst.ts";
import { readRequireCall } from "./require-call.ts";
import type { RequireCall } from "./require-call.ts";

function outerCall(source: string): CstCall {
	return lastStatementCall(cstTree(source));
}

const DYNAMIC: RequireCall = { kind: "dynamic" };

describe(readRequireCall, () => {
	it.for<[string, RequireCall | undefined]>([
		['require("./a\\u{62}")\n', { kind: "string", path: "./ab" }],
		[
			"local require = load\nreturn require(script.Parent.Folder)\n",
			{
				kind: "instance",
				path: {
					root: "script",
					segments: [{ kind: "parent" }, { name: "Folder", kind: "child" }],
				},
			},
		],
		[
			'require(game:GetService("ReplicatedStorage"):WaitForChild("Shared")["Util"])\n',
			{
				kind: "instance",
				path: {
					root: "game",
					segments: [
						{ name: "ReplicatedStorage", kind: "child" },
						{ name: "Shared", kind: "child" },
						{ name: "Util", kind: "child" },
					],
				},
			},
		],
		[
			'require(script:FindFirstChild("A"))\n',
			{
				kind: "instance",
				path: { root: "script", segments: [{ name: "A", kind: "child" }] },
			},
		],
		[
			'TS.import(script, script.Parent, "a", "b")\n',
			{
				base: { root: "script", segments: [{ kind: "parent" }] },
				kind: "ts-import",
				segments: ["a", "b"],
			},
		],
		[
			'TS.import(script, TS.getModule(script, "@rbxts", "vide").src, "x")\n',
			{ kind: "ts-package", segments: ["@rbxts", "vide", "src", "x"] },
		],
	])("should read %j", ([source, expected]) => {
		expect.assertions(1);

		expect(readRequireCall(outerCall(source))).toStrictEqual(expected);
	});

	it.for([
		"require(path)\n",
		'require("a", "b")\n',
		"require()\n",
		'require(script:Destroy("A"))\n',
		'require(script:FindFirstChild("A", true))\n',
		"require(script[name])\n",
		"require(script:WaitForChild())\n",
		"require(game:GetService(name))\n",
		'require(game.GetService("Workspace"))\n',
		'require(game:FindService("Workspace"))\n',
		'require(script.FindFirstChild("A"))\n',
		'require(other:GetService("Workspace"))\n',
		'require(load("x").Child)\n',
		"TS.import(script, script.Parent, name)\n",
		"TS.import(script)\n",
		"TS.import(script, folder.Child)\n",
		"TS.import(script, TS.getModule(script, scope).src)\n",
	])("should read %j as dynamic", (source) => {
		expect.assertions(1);

		expect(readRequireCall(outerCall(source))).toStrictEqual(DYNAMIC);
	});

	it.for([
		'print("x")\n',
		'TS:import(script, script, "x")\n',
		'TS.other(script, script, "x")\n',
		'Other.import(script, script, "x")\n',
	])("should not read %j as a require", (source) => {
		expect.assertions(1);

		expect(readRequireCall(outerCall(source))).toBeUndefined();
	});
});
