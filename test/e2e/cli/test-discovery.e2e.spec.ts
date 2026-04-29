import path from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "./helpers.ts";

const LUAU_FIXTURE = path.resolve(__dirname, "../fixtures/luau-project");
const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");

describe("test discovery", () => {
	describe("luau project", () => {
		it("should find .spec.luau test files", () => {
			expect.assertions(1);

			const result = runCli([], LUAU_FIXTURE);

			// If test discovery succeeded, the CLI proceeds to the backend
			// which fails with a backend error (game.rbxl not found).
			// "No test files found" in stderr means discovery failed.
			expect(result.stderr).not.toContain("No test files found");
		});
	});

	describe("roblox-ts project", () => {
		it("should find .spec.ts test files", () => {
			expect.assertions(1);

			const result = runCli([], RBXTS_FIXTURE);

			// Backend error ("Failed to find Jest") means config + discovery
			// worked.
			expect(result.stderr).not.toContain("No test files found");
		});
	});
});
