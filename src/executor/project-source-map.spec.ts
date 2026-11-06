import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { createPassingResult } from "#test/mocks/executor-spec-results.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { buildProjectSourceMap, resolveTestFilePaths } from "./project-source-map.ts";

const ROOT = path.join(process.cwd(), "modules", "app");
const POSIX_ROOT = ROOT.replaceAll("\\", "/");

function resolveMappedPath(mount: string): string {
	const { fileSystem } = createMemoryFileSystem({
		[path.join(ROOT, ".generated", "test.project.json")]: JSON.stringify({
			name: "app",
			tree: { $className: "DataModel", ReplicatedStorage: { $path: mount } },
		}),
	});
	const sourceMap = buildProjectSourceMap({
		config: {
			...createResolvedConfig(),
			rojoProject: ".generated/test.project.json",
			rootDir: ROOT,
		},
		fileSystem,
		tsconfigMappings: [],
	});
	const result = createPassingResult();
	result.testResults[0]!.testFilePath = "/ReplicatedStorage/__tests__/init.spec";

	resolveTestFilePaths(result, sourceMap);

	return result.testResults[0]!.testFilePath;
}

describe(resolveTestFilePaths, () => {
	it("should resolve a mount relative to the Rojo project into an absolute path", () => {
		expect.assertions(1);

		expect(resolveMappedPath("../src")).toBe(`${POSIX_ROOT}/src/__tests__/init.spec.luau`);
	});

	it("should keep a path from an absolute mount as it is", () => {
		expect.assertions(1);

		expect(resolveMappedPath(`${POSIX_ROOT}/src`)).toBe(
			`${POSIX_ROOT}/src/__tests__/init.spec.luau`,
		);
	});
});

describe(buildProjectSourceMap, () => {
	it("should map a failure frame under a relative mount to an absolute Luau path", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem({
			[path.join(ROOT, ".generated", "test.project.json")]: JSON.stringify({
				name: "app",
				tree: { $className: "DataModel", ReplicatedStorage: { $path: "../src" } },
			}),
			[path.join(ROOT, "src", "__tests__", "fail.spec.lua")]: "",
		});
		const sourceMap = buildProjectSourceMap({
			config: {
				...createResolvedConfig(),
				rojoProject: ".generated/test.project.json",
				rootDir: ROOT,
			},
			fileSystem,
			tsconfigMappings: [],
		});

		const { locations } = sourceMap!.sourceMapper.mapFailureWithLocations(
			'[string "ReplicatedStorage.__tests__.fail.spec"]:4: boom',
		);

		expect(locations[0]!.luauPath).toBe(`${POSIX_ROOT}/src/__tests__/fail.spec.lua`);
	});
});
