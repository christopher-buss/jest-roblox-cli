import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ExecutionClaimObservation } from "../luau/execution-claim.ts";
import { createBootWatch } from "./execution-boot-watch.ts";

type ReadClaim = (key: string, signal: AbortSignal) => Promise<ExecutionClaimObservation>;

function useFakeTimers(): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

function watch({
	readClaimAsync,
	watchesSubmission = false,
}: {
	readClaimAsync?: ReadClaim | undefined;
	watchesSubmission?: boolean;
}) {
	return createBootWatch({
		key: "execution-key",
		bootWatchMs: 1_000,
		readClaimAsync,
		watchesSubmission,
	});
}

describe(createBootWatch, () => {
	it("should read the claim once the boot window passes", async () => {
		expect.assertions(3);

		useFakeTimers();
		const readClaimAsync = vi.fn<ReadClaim>().mockResolvedValue({ status: "missing" });
		const boot = watch({ readClaimAsync });

		await vi.advanceTimersByTimeAsync(999);

		expect(readClaimAsync).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		const observed = await boot.promise;

		expect(observed.status).toBe("missing");
		expect(readClaimAsync).toHaveBeenCalledExactlyOnceWith(
			"execution-key",
			expect.any(AbortSignal),
		);
	});

	it.for<[string, ReadClaim | undefined, "failed" | "found"]>([
		[
			"a failed read",
			async () => {
				throw new Error("MemoryStore unavailable");
			},
			"failed",
		],
		["no observer", undefined, "found"],
	])("should report %s", async ([, readClaimAsync, status]) => {
		expect.assertions(1);

		useFakeTimers();
		const boot = watch({ readClaimAsync });
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(boot.promise).resolves.toMatchObject({ status });
	});

	it("should keep one pending observation across repeated re-arms", async () => {
		expect.assertions(1);

		useFakeTimers();
		const boot = watch({ watchesSubmission: true });
		boot.submission.accepted();
		await vi.advanceTimersByTimeAsync(1_000);
		boot.submission.accepted();
		const pending = boot.promise;

		boot.submission.accepted();

		expect(boot.promise).toBe(pending);
	});

	it("should start watching for a claim only after submission is accepted", async () => {
		expect.assertions(2);

		useFakeTimers();
		const readClaimAsync = vi.fn<ReadClaim>().mockResolvedValue({ status: "missing" });
		const boot = watch({ readClaimAsync, watchesSubmission: true });
		await vi.advanceTimersByTimeAsync(60_000);

		expect(readClaimAsync).not.toHaveBeenCalled();

		boot.submission.accepted();
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(boot.promise).resolves.toMatchObject({ status: "missing" });
	});

	it("should not arm once canceled", async () => {
		expect.assertions(2);

		useFakeTimers();
		const readClaimAsync = vi.fn<ReadClaim>().mockResolvedValue({ status: "missing" });
		const boot = watch({ readClaimAsync, watchesSubmission: true });
		boot.cancel();
		boot.submission.accepted();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(readClaimAsync).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should abort an in-flight read and mark its result stale when re-armed", async () => {
		expect.assertions(3);

		useFakeTimers();
		const first = Promise.withResolvers<ExecutionClaimObservation>();
		const signals: Array<AbortSignal> = [];
		const readClaimAsync = vi
			.fn<ReadClaim>()
			.mockImplementationOnce(async (_key, signal) => {
				signals.push(signal);
				return first.promise;
			})
			.mockResolvedValue({ claim: { claimedAt: 1, owner: "x" }, status: "found" });
		const boot = watch({ readClaimAsync });
		await vi.advanceTimersByTimeAsync(1_000);
		boot.submission.accepted();
		const pending = boot.promise;
		first.resolve({ status: "missing" });
		await vi.advanceTimersByTimeAsync(1_000);
		const observed = await pending;

		expect(signals[0]!.aborted).toBeTrue();
		expect(observed.status).toBe("found");
		expect(boot.isCurrent(observed)).toBeTrue();
	});

	it("should replace a consumed observation when re-armed", async () => {
		expect.assertions(2);

		useFakeTimers();
		const boot = watch({ readClaimAsync: async () => ({ status: "missing" }) });
		await vi.advanceTimersByTimeAsync(1_000);
		const consumed = await boot.promise;
		boot.submission.accepted();

		expect(boot.isCurrent(consumed)).toBeFalse();

		await vi.advanceTimersByTimeAsync(1_000);
		const next = await boot.promise;

		expect(next.generation).not.toBe(consumed.generation);
	});
});
