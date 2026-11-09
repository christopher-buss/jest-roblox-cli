import { describe, it } from "vitest";

import { createReverseMapper } from "./reverse-mapper.ts";

describe(createReverseMapper, () => {
	it("should distinguish instance paths with equal concatenated names", ({ expect }) => {
		expect.assertions(2);

		const paths = new Map<string, ReadonlyArray<string>>([
			["/one.luau", ["game", "AB", "C"]],
			["/two.luau", ["game", "A", "BC"]],
		]);
		const mapper = createReverseMapper([...paths.keys()], (filePath) => paths.get(filePath));

		expect(mapper.resolve(["game", "AB", "C"])).toBe("/one.luau");
		expect(mapper.resolve(["game", "A", "BC"])).toBe("/two.luau");
	});

	it("should resolve a file by its RbxPath", ({ expect }) => {
		expect.assertions(1);

		const files = ["/project/src/module.luau"];
		const rbxPath = ["game", "ReplicatedStorage", "module"];
		function getRbxPath(_path: string): ReadonlyArray<string> {
			return rbxPath;
		}

		const mapper = createReverseMapper(files, getRbxPath);

		expect(mapper.resolve(rbxPath)).toBe("/project/src/module.luau");
	});

	it("should return undefined for an unknown RbxPath", ({ expect }) => {
		expect.assertions(1);

		const files = ["/project/src/module.luau"];
		function getRbxPath(_path: string): ReadonlyArray<string> {
			return ["game", "ReplicatedStorage", "module"];
		}

		const mapper = createReverseMapper(files, getRbxPath);

		expect(mapper.resolve(["game", "ServerStorage", "unknown"])).toBeUndefined();
	});

	it("should resolve multiple files by their RbxPaths", ({ expect }) => {
		expect.assertions(2);

		const pathMap = new Map<string, ReadonlyArray<string>>([
			["/project/src/bar.luau", ["game", "ReplicatedStorage", "bar"]],
			["/project/src/foo.luau", ["game", "ReplicatedStorage", "foo"]],
		]);
		function getRbxPath(path: string): ReadonlyArray<string> | undefined {
			return pathMap.get(path);
		}

		const mapper = createReverseMapper([...pathMap.keys()], getRbxPath);

		expect(mapper.resolve(["game", "ReplicatedStorage", "foo"])).toBe("/project/src/foo.luau");
		expect(mapper.resolve(["game", "ReplicatedStorage", "bar"])).toBe("/project/src/bar.luau");
	});

	it("should skip files where getRbxPath returns undefined", ({ expect }) => {
		expect.assertions(2);

		const files = ["/project/src/known.luau", "/project/src/unknown.luau"];
		const pathMap = new Map<string, ReadonlyArray<string>>([
			["/project/src/known.luau", ["game", "ReplicatedStorage", "known"]],
		]);
		function getRbxPath(path: string): ReadonlyArray<string> | undefined {
			return pathMap.get(path);
		}

		const mapper = createReverseMapper(files, getRbxPath);

		expect(mapper.resolve(["game", "ReplicatedStorage", "known"])).toBe(
			"/project/src/known.luau",
		);
		expect(mapper.resolve(["game", "ReplicatedStorage", "unknown"])).toBeUndefined();
	});

	it("should let a file added later win a shared RbxPath", ({ expect }) => {
		expect.assertions(1);

		const mapper = createReverseMapper(["/first.luau"], () => ["game", "module"]);
		mapper.add(["/second.luau"]);

		expect(mapper.resolve(["game", "module"])).toBe("/second.luau");
	});
});
