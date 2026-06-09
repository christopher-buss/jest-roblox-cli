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

			// Discovery runs before backend resolution, so reaching backend
			// resolution proves discovery found the spec files. A discovery
			// failure prints "No test files found" instead.
			expect(result.stderr).not.toContain("No test files found");
		});
	});

	describe("roblox-ts project", () => {
		it("should find .spec.ts test files", () => {
			expect.assertions(1);

			const result = runCli([], RBXTS_FIXTURE);

			expect(result.stderr).not.toContain("No test files found");
		});
	});
});
