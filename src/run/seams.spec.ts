import { describe, expect, it } from "vitest";

import { nodeRunSeams } from "./seams.ts";

describe(nodeRunSeams, () => {
	it("should bind every member to its real stage", () => {
		expect.assertions(4);

		const seams = nodeRunSeams();

		expect(() => seams.childProcess.spawn("git")).toThrow(/\(spawn\)/);
		expect(seams.openBackend).toHaveProperty("name", "openBackend");
		expect(seams.runProjects).toHaveProperty("name", "executeJobsAsync");
		expect(Object.values(seams).every((member) => member !== undefined)).toBeTrue();
	});
});
