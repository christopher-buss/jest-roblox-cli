import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { LOCKFILES } from "./lockfiles.ts";

describe("lockfiles", () => {
	it("should hold the lockfiles of the npm and Roblox package managers", () => {
		expect.assertions(2);

		expect(LOCKFILES).toContain("pnpm-lock.yaml");
		expect(LOCKFILES).toContain("wally.lock");
	});

	it("should name only files at the workspace root", () => {
		expect.assertions(1);

		expect(LOCKFILES.map((file) => path.basename(file))).toStrictEqual(LOCKFILES);
	});
});
