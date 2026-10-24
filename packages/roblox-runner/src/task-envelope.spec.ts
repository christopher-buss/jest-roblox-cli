import { describe, expect, it, vi } from "vitest";

import { buildTaskParameters, completedResult } from "./task-envelope.ts";

describe(buildTaskParameters, () => {
	it.for([
		{ binaryInput: undefined, expected: {}, placeVersion: undefined },
		{
			binaryInput: "inputs/3",
			expected: { binaryInput: "inputs/3", versionId: "0" },
			placeVersion: 0,
		},
		{ binaryInput: "", expected: { binaryInput: "", versionId: "17" }, placeVersion: 17 },
	])(
		"should preserve optional request keys without sending undefined: %j",
		({ binaryInput, expected, placeVersion }) => {
			expect.assertions(1);

			expect(
				buildTaskParameters({
					binaryInput,
					credentials: { apiKey: "key", placeId: "2", universeId: "1" },
					placeVersion,
					script: "return 7",
					timeoutSeconds: 5,
				}),
			).toStrictEqual({
				placeId: "2",
				script: "return 7",
				timeoutSeconds: 5,
				universeId: "1",
				...expected,
			});
		},
	);
});

describe(completedResult, () => {
	it("should serialize non-string outputs and retain terminal identity and host elapsed time", () => {
		expect.assertions(1);

		vi.spyOn(Date, "now").mockReturnValue(123);

		expect(
			completedResult(
				{
					output: { results: ["text", 5, false, null, { answer: 7 }, [1, 2]] },
					ref: {
						placeId: "2",
						sessionId: "session",
						taskId: "task",
						universeId: "1",
						versionId: "7",
					},
					state: "COMPLETE",
					user: "users/1",
				},
				100,
			),
		).toStrictEqual({
			durationMs: 23,
			outputs: ["text", "5", "false", "null", '{"answer":7}', "[1,2]"],
			terminalTask: { ref: { sessionId: "session", taskId: "task" }, state: "COMPLETE" },
		});
	});
});
