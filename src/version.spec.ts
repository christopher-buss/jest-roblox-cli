import { describe, expect, it } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { VERSION } from "./version.ts";

describe("version", () => {
	it("should be the package version", () => {
		expect.assertions(1);

		expect(VERSION).toBe(packageJson.version);
	});
});
