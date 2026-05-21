import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { loadLuauConfig } from "./luau-config-loader.ts";

function createTemporaryConfig(source: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "luau-config-loader-test-"));
	const filePath = path.join(directory, "jest.config.luau");
	writeFileSync(filePath, source);
	onTestFinished(() => {
		rmSync(directory, { recursive: true });
	});
	return filePath;
}

describe("loadLuauConfig lute integration", () => {
	it("should preserve string-valued config fields end-to-end", () => {
		expect.assertions(1);

		const filePath = createTemporaryConfig(`return {
	displayName = "luau-integration",
	testMatch = { "**/*.spec.luau" },
}
`);

		const result = loadLuauConfig(filePath);

		expect(result).toStrictEqual({
			displayName: "luau-integration",
			testMatch: ["**/*.spec.luau"],
		});
	});
});
