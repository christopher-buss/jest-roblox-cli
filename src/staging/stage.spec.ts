import { describe, expect, it } from "vitest";

import { findStage, STAGE_KEY } from "./stage.ts";

describe(findStage, () => {
	it("should find the stage under ServerStorage", () => {
		expect.assertions(1);

		const stage = { $className: "Folder" };

		expect(findStage({ tree: { ServerStorage: { [STAGE_KEY]: stage } } })).toBe(stage);
	});

	it("should report no stage when the tree is missing", () => {
		expect.assertions(1);

		expect(findStage({})).toBeUndefined();
	});

	it("should report no stage when ServerStorage is missing", () => {
		expect.assertions(1);

		expect(findStage({ tree: { ReplicatedStorage: {} } })).toBeUndefined();
	});

	it("should report no stage when ServerStorage holds none", () => {
		expect.assertions(1);

		expect(findStage({ tree: { ServerStorage: { Other: {} } } })).toBeUndefined();
	});
});
