import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CODE_BUNDLE_REBUILD_SOURCE } from "./code-bundle-rebuild.ts";

const CURRENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

describe("the code bundle rebuild source", () => {
	it("should be the module the lute harness runs", () => {
		expect.assertions(1);

		// The harness reads the file; the host imports it through the raw
		// loader. A spec proving one is the other is what keeps the pinned
		// behaviour and the shipped text the same thing.
		const fromDisk = fs.readFileSync(
			path.join(CURRENT_DIRECTORY, "../../luau/code-bundle-rebuild.luau"),
			"utf-8",
		);

		expect(CODE_BUNDLE_REBUILD_SOURCE).toBe(fromDisk);
	});
});
