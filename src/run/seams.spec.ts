import { execFile, execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { nodeRunSeams } from "./seams.ts";

describe(nodeRunSeams, () => {
	it("should bind every member to its real stage", () => {
		expect.assertions(4);

		const seams = nodeRunSeams();

		expect(seams.childProcess).toStrictEqual(
			expect.objectContaining({ execFile, execFileSync, spawn }),
		);
		expect(seams.resolveBackend).toHaveProperty("name", "resolveBackendAsync");
		expect(seams.runProjects).toHaveProperty("name", "runProjectsAsync");
		expect(Object.values(seams).every((member) => member !== undefined)).toBeTrue();
	});
});
