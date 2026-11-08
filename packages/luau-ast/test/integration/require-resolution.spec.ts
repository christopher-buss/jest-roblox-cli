import {
	createStringRequireResolver,
	forEachCstNode,
	loadLuauParser,
	readRequireCall,
} from "@isentinel/luau-ast";
import type { RequireCall } from "@isentinel/luau-ast";

import fs from "node:fs";
import path from "node:path";
import { assert, describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "../fixtures/require");

interface ReadRequire {
	read: RequireCall;
	resolved?: string;
}

function readFixture(relativePath: string): Array<ReadRequire> {
	const parser = loadLuauParser();
	const resolve = createStringRequireResolver({ fileSystem: fs, parser });
	const filePath = path.join(ROOT, relativePath);
	const parsed = parser.parseCst({
		fileName: filePath,
		source: fs.readFileSync(filePath, "utf-8"),
	});
	assert(parsed.ok, relativePath);

	const requires: Array<ReadRequire> = [];
	forEachCstNode(parsed.root, (node) => {
		const read = node.type === "Call" ? readRequireCall(node) : undefined;
		if (read?.kind === "string") {
			const resolution = resolve(filePath, read.path);
			assert(resolution.kind === "resolved", JSON.stringify(resolution));
			requires.push({
				read,
				resolved: path.relative(ROOT, resolution.path).replaceAll("\\", "/"),
			});
		} else if (read !== undefined) {
			requires.push({ read });
		}
	});
	return requires;
}

describe("require resolution", () => {
	it.for<[string, ReadRequire]>([
		[
			"src/relative.luau",
			{ read: { kind: "string", path: "./sibling" }, resolved: "src/sibling.luau" },
		],
		["src/up.luau", { read: { kind: "string", path: "../parent" }, resolved: "parent.luau" }],
		[
			"src/feature/init.luau",
			{ read: { kind: "string", path: "@self/part" }, resolved: "src/feature/part.luau" },
		],
		[
			"src/config-alias.luau",
			{ read: { kind: "string", path: "@shared/util" }, resolved: "shared/util.luau" },
		],
		[
			"src/luaurc-alias.luau",
			{ read: { kind: "string", path: "@rc" }, resolved: "rc-lib/init.luau" },
		],
		[
			"src/instance-path.luau",
			{
				read: {
					kind: "instance",
					path: {
						root: "script",
						segments: [{ kind: "parent" }, { name: "sibling", kind: "child" }],
					},
				},
			},
		],
		[
			"src/get-service.luau",
			{
				read: {
					kind: "instance",
					path: {
						root: "game",
						segments: [
							{ name: "ReplicatedStorage", kind: "child" },
							{ name: "Shared", kind: "child" },
						],
					},
				},
			},
		],
		[
			"src/ts-import.luau",
			{
				read: {
					base: { root: "script", segments: [{ kind: "parent" }] },
					kind: "ts-import",
					segments: ["sibling"],
				},
			},
		],
		["src/dynamic.luau", { read: { kind: "dynamic" } }],
	])("should read and resolve the require in %s", ([relativePath, expected]) => {
		expect.assertions(1);

		expect(readFixture(relativePath)).toStrictEqual([expected]);
	});
});
