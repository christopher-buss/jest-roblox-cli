import { TaskStallError } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import { isInfrastructureFailure, MissingGapRecordError } from "./infrastructure-failure.ts";

function createStall(): TaskStallError {
	return new TaskStallError({
		error: new Error("Execution timed out"),
		evidence: {
			createTime: undefined,
			kind: "task-stall",
			observedStates: ["PROCESSING"],
			placeVersion: undefined,
			task: "universes/1/places/2/luau-execution-sessions/s/tasks/t",
			timeoutSeconds: 300,
			updateTime: undefined,
		},
		readResultAsync: async () => ({ durationMs: 0, outputs: [] }),
	});
}

describe(isInfrastructureFailure, () => {
	it("should accept each infrastructure failure and reject any other error", () => {
		expect.assertions(3);

		expect(isInfrastructureFailure(createStall())).toBeTrue();
		expect(isInfrastructureFailure(new MissingGapRecordError("lost"))).toBeTrue();
		expect(isInfrastructureFailure(new Error("other"))).toBeFalse();
	});
});
