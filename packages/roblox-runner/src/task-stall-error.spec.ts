import { NetworkError, PollTimeoutError } from "@bedrock-rbx/ocale";

import { assert, describe, expect, it, vi } from "vitest";

import { makePollContext } from "#test/helpers/unit/poll-context.ts";
import { TaskStallError, toExecutionError } from "./task-stall-error.ts";

describe(toExecutionError, () => {
	it("should retain ordinary poll failures without attempting recovery", () => {
		expect.assertions(3);

		const error = new NetworkError("offline");
		const readResultAsync = vi.fn<Parameters<typeof toExecutionError>[0]["readResultAsync"]>();
		const described = toExecutionError({
			context: makePollContext(),
			error,
			readResultAsync,
		});

		expect(described.message).toBe("offline");
		expect(described.cause).toBe(error);
		expect(readResultAsync).not.toHaveBeenCalled();
	});

	it("should recover by polling the same task and forwarding the observation signal", async () => {
		expect.assertions(3);

		const error = new PollTimeoutError("timeout", { timeoutMs: 1 });
		const recovered = { durationMs: 11, outputs: ["late"] };
		const readResultAsync = vi.fn<Parameters<typeof toExecutionError>[0]["readResultAsync"]>(
			async () => recovered,
		);
		const described = toExecutionError({
			context: makePollContext(),
			error,
			readResultAsync,
		});
		assert(described instanceof TaskStallError);
		const { signal } = new AbortController();

		expect(described).toMatchObject({
			name: "TaskStallError",
			cause: error,
			evidence: {
				kind: "task-stall",
				observedStates: ["PROCESSING"],
				timeoutSeconds: 1,
			},
		});
		await expect(described.readResultAsync(signal)).resolves.toBe(recovered);
		expect(readResultAsync).toHaveBeenCalledExactlyOnceWith(signal);
	});
});
