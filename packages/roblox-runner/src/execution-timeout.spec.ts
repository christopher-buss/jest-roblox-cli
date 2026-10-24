import { describe, expect, it, vi } from "vitest";

import { ExecutionTimeoutError } from "./execution-timeout.ts";

describe(ExecutionTimeoutError, () => {
	it("should preserve the original cause and recover through the supplied observer", async () => {
		expect.assertions(4);

		const cause = new Error("transport");
		const readResultAsync = vi.fn<
			(signal?: AbortSignal) => Promise<{ durationMs: number; outputs: Array<string> }>
		>(async () => ({ durationMs: 7, outputs: ["late"] }));
		const error = new ExecutionTimeoutError(new Error("timed out", { cause }), readResultAsync);
		const { signal } = new AbortController();

		expect(error.message).toBe("timed out");
		expect(error.cause).toBe(cause);
		await expect(error.readResultAsync(signal)).resolves.toStrictEqual({
			durationMs: 7,
			outputs: ["late"],
		});
		expect(readResultAsync).toHaveBeenCalledExactlyOnceWith(signal);
	});
});
