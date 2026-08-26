import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createTsconfigMappingCache,
	isLuauProject,
	readTsconfigMapping,
	resolveAllTsconfigMappings,
	resolveTsconfigDirectories,
} from "./tsconfig-mappings.ts";

// cspell:ignore xtsconfig
const getTsconfig = vi.hoisted(() => vi.fn<typeof import("get-tsconfig").getTsconfig>());
const collator = new Intl.Collator("en");

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

vi.mock(import("get-tsconfig"), () => ({ getTsconfig }));

function resetTestState(): void {
	vol.reset();
	getTsconfig.mockReset();
}

describe(isLuauProject, () => {
	it("should require no TypeScript source files and no tsconfig mappings", () => {
		expect.assertions(4);

		expect(isLuauProject(["src/main.luau"], [])).toBeTrue();
		expect(isLuauProject(["src/main.ts"], [])).toBeFalse();
		expect(isLuauProject(["src/main.tsx"], [])).toBeFalse();
		expect(isLuauProject(["src/main.luau"], [{ outDir: "out", rootDir: "src" }])).toBeFalse();
	});
});

describe(createTsconfigMappingCache, () => {
	it("should create an empty independent cache", () => {
		expect.assertions(3);

		const first = createTsconfigMappingCache();
		const second = createTsconfigMappingCache();
		first.set("project", [{ outDir: "out", rootDir: "src" }]);

		expect(first).toBeInstanceOf(Map);
		expect(second).not.toBe(first);
		expect(second).toStrictEqual(new Map());
	});
});

describe(readTsconfigMapping, () => {
	it("should treat empty rootDirs as absent", () => {
		expect.assertions(1);

		resetTestState();
		vol.fromJSON({
			"/project/tsconfig.json": JSON.stringify({
				compilerOptions: { outDir: "out-test", rootDir: "test", rootDirs: [] },
			}),
		});

		expect(readTsconfigMapping("/project/tsconfig.json")).toStrictEqual({
			outDir: "out-test",
			rootDir: "test",
		});
	});

	it("should find the common ancestor when one rootDir contains another", () => {
		expect.assertions(1);

		resetTestState();
		vol.fromJSON({
			"/project/tsconfig.json": JSON.stringify({
				compilerOptions: {
					outDir: "out",
					rootDirs: ["packages/core", "packages/core/test"],
				},
			}),
		});

		expect(readTsconfigMapping("/project/tsconfig.json")).toStrictEqual({
			outDir: "out",
			rootDir: "packages/core",
		});
	});
});

describe(resolveAllTsconfigMappings, () => {
	it("should scan only tsconfig JSON files, deduplicate mappings, sort longest first, and cache", () => {
		expect.assertions(3);

		resetTestState();
		vol.fromJSON({
			"/project/tsconfig.json": "{}",
			"/project/tsconfig.json.bak": "{}",
			"/project/tsconfig.lib.json": "{}",
			"/project/xtsconfig.json": "{}",
		});
		const outputDirectories = new Map([
			["tsconfig.json", "out"],
			["tsconfig.lib.json", "out/generated"],
		]);
		getTsconfig.mockImplementation((_root, filename) => {
			return fromAny({
				config: {
					compilerOptions: { outDir: outputDirectories.get(filename!), rootDir: "src" },
				},
			});
		});
		const cache = createTsconfigMappingCache();

		const first = resolveAllTsconfigMappings("/project", cache);
		const second = resolveAllTsconfigMappings("/project", cache);

		expect(first).toStrictEqual([
			{ outDir: "out/generated", rootDir: "src" },
			{ outDir: "out", rootDir: "src" },
		]);
		expect(second).toBe(first);
		expect(
			getTsconfig.mock.calls
				.map((call) => call[1])
				.toSorted((left, right) => collator.compare(left!, right!)),
		).toStrictEqual(["tsconfig.json", "tsconfig.lib.json"]);
	});
});

describe(resolveTsconfigDirectories, () => {
	it("should reject a tsconfig in a sibling directory with the same path prefix", () => {
		expect.assertions(1);

		resetTestState();
		getTsconfig.mockReturnValue(
			fromAny({
				config: { compilerOptions: { outDir: "out", rootDir: "src" } },
				path: path.resolve("/project-sibling/tsconfig.lib.json"),
			}),
		);

		expect(resolveTsconfigDirectories("/project")).toStrictEqual({
			outDir: undefined,
			rootDir: undefined,
		});
	});
});
