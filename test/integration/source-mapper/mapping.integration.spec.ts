import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSourceMapper, type RojoProject } from "../../../src/source-mapper/index.ts";
import type { TsconfigMapping } from "../../../src/types/tsconfig.ts";
import { normalizeWindowsPath } from "../../../src/utils/normalize-windows-path.ts";
import { createRbxtsFixtureSandbox } from "../../e2e/cli/helpers.ts";

const normalize = normalizeWindowsPath;
const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");
const LUAU_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/luau-project");

function createRbxtsFixtureMapper(rootDirectory: string) {
	const outDirectory = normalize(path.join(rootDirectory, "out"));
	const sourceDirectory = normalize(path.join(rootDirectory, "src"));

	const rojoProject: RojoProject = {
		name: "rbxts-e2e",
		tree: {
			$className: "DataModel",
			ReplicatedStorage: {
				$className: "ReplicatedStorage",
				shared: { $path: outDirectory },
			},
		},
	};

	const mappings: Array<TsconfigMapping> = [{ outDir: outDirectory, rootDir: sourceDirectory }];

	return createSourceMapper({ mappings, rojoProject });
}

function createLuauFixtureMapper() {
	const sourceDirectory = normalize(path.join(LUAU_FIXTURE, "src"));

	const rojoProject: RojoProject = {
		name: "luau-e2e",
		tree: {
			$className: "DataModel",
			ReplicatedStorage: {
				$className: "ReplicatedStorage",
				src: { $path: sourceDirectory },
			},
		},
	};

	return createSourceMapper({ mappings: [], rojoProject });
}

describe("source mapping", () => {
	describe("roblox-ts project", () => {
		it("should map luau line to typescript source", () => {
			expect.assertions(3);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = createRbxtsFixtureMapper(fixtureRoot);

			// example.luau line 3 = `return \`hello {name}\``
			// maps to example.ts line 2 = `return \`hello ${name}\``
			const message = 'Error\n[string "ReplicatedStorage.shared.example"]:3';
			const result = mapper.mapFailureWithLocations(message);

			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]?.tsLine).toBe(2);
			expect(result.locations[0]?.tsPath).toContain("example.ts");
		});

		it("should map spec file luau line to typescript source", () => {
			expect.assertions(3);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = createRbxtsFixtureMapper(fixtureRoot);

			// example.spec.luau line 6 = `local result = greet("Alice")`
			// maps to example.spec.ts line 3 = `const result = greet("Alice");`
			const message = 'Error\n[string "ReplicatedStorage.shared.example.spec"]:6';
			const result = mapper.mapFailureWithLocations(message);

			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]?.tsLine).toBe(3);
			expect(result.locations[0]?.tsPath).toContain("example.spec.ts");
		});

		it("should resolve test file path from DataModel path", () => {
			expect.assertions(1);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = createRbxtsFixtureMapper(fixtureRoot);

			const resolved = mapper.resolveTestFilePath("/ReplicatedStorage/shared/example.spec");

			expect(resolved).toBeDefined();
		});
	});

	describe("luau project", () => {
		it("should pass through luau paths without source mapping", () => {
			expect.assertions(2);

			const mapper = createLuauFixtureMapper();

			const message = 'Error\n[string "ReplicatedStorage.src.example.spec"]:5';
			const result = mapper.mapFailureWithLocations(message);

			// Luau project: no TS mapping, path resolves to luau file
			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]?.tsPath).toBeUndefined();
		});
	});
});
