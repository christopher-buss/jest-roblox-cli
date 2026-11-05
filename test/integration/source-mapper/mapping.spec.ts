import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFixtureSandbox, createRbxtsFixtureSandbox } from "#test/e2e/cli/helpers.ts";
import { buildProjectSourceMapperAsync } from "#test/integration/source-mapper/project-source-mapper.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/rbxts-project");
const LUAU_FIXTURE = path.resolve(__dirname, "../../e2e/fixtures/luau-project");

describe("source mapping", { timeout: 30_000 }, () => {
	describe("roblox-ts project", () => {
		it("should map luau line to typescript source", async () => {
			expect.assertions(3);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = await buildProjectSourceMapperAsync(fixtureRoot);

			// example.luau line 3 = `return \`hello {name}\``
			// maps to example.ts line 2 = `return \`hello ${name}\``
			const message = 'Error\n[string "ReplicatedStorage.shared.example"]:3';
			const result = mapper.mapFailureWithLocations(message);

			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]!.tsLine).toBe(2);
			expect(result.locations[0]!.tsPath).toContain("example.ts");
		});

		it("should map spec file luau line to typescript source", async () => {
			expect.assertions(3);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = await buildProjectSourceMapperAsync(fixtureRoot);

			// example.spec.luau line 6 = `local result = greet("Alice")`
			// maps to example.spec.ts line 3 = `const result = greet("Alice");`
			const message = 'Error\n[string "ReplicatedStorage.shared.example.spec"]:6';
			const result = mapper.mapFailureWithLocations(message);

			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]!.tsLine).toBe(3);
			expect(result.locations[0]!.tsPath).toContain("example.spec.ts");
		});

		it("should resolve test file path from DataModel path", async () => {
			expect.assertions(1);

			const fixtureRoot = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
			const mapper = await buildProjectSourceMapperAsync(fixtureRoot);

			const resolved = mapper.resolveTestFilePath("/ReplicatedStorage/shared/example.spec");

			expect(resolved).toBeDefined();
		});
	});

	describe("luau project", () => {
		it("should pass through luau paths without source mapping", async () => {
			expect.assertions(2);

			const mapper = await buildProjectSourceMapperAsync(createFixtureSandbox(LUAU_FIXTURE));

			const message = 'Error\n[string "ReplicatedStorage.src.example.spec"]:5';
			const result = mapper.mapFailureWithLocations(message);

			// Luau project: no TS mapping, path resolves to luau file
			expect(result.locations).toHaveLength(1);
			expect(result.locations[0]!.tsPath).toBeUndefined();
		});
	});
});
