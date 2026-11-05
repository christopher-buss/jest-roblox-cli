import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { nodeFileSystem } from "./file-system.ts";

const PACKAGE_JSON = path.resolve(import.meta.dirname, "../../package.json");

describe("nodeFileSystem", () => {
	it("should read the real disk through the sync API", () => {
		expect.assertions(1);

		expect(nodeFileSystem.readFileSync(PACKAGE_JSON, "utf-8")).toContain('"name"');
	});

	it("should read the real disk through the promise API", async () => {
		expect.assertions(1);

		await expect(nodeFileSystem.promises.readFile(PACKAGE_JSON, "utf-8")).resolves.toContain(
			'"name"',
		);
	});
});
