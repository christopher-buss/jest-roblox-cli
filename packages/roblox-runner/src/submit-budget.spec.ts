import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import {
	combineSubmitSignals,
	createSubmitBudgetController,
	maximumSubmitDuration,
	pauseBudgetWhileWaiting,
	waitForSubmitRetryAsync,
} from "./submit-budget.ts";

describe("submission wait accounting", () => {
	it("should exclude overlapping waits once and preserve spent inactivity", async () => {
		expect.assertions(3);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		const first = budget.pause();
		assert(first !== undefined);
		await vi.advanceTimersByTimeAsync(20_000);
		const second = budget.pause();
		assert(second !== undefined);
		await vi.advanceTimersByTimeAsync(20_000);
		first();
		first();
		await vi.advanceTimersByTimeAsync(20_000);
		second();
		await vi.advanceTimersByTimeAsync(29_999);

		expect(cancelSubmitting).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
		await expect(observed).resolves.toContain("90s inactivity limit");
	});

	it("should not refund waiting time before genuine progress renewed inactivity", async () => {
		expect.assertions(3);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		const finish = budget.pause();
		assert(finish !== undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		budget.progress("new blocker");
		await vi.advanceTimersByTimeAsync(30_000);
		finish();
		await vi.advanceTimersByTimeAsync(89_999);

		expect(cancelSubmitting).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
		await expect(observed).resolves.toContain("90s inactivity limit");
	});

	it("should keep the absolute deadline active and ignore cleanup after settlement", async () => {
		expect.assertions(4);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		const finish = budget.pause();
		assert(finish !== undefined);
		await vi.advanceTimersByTimeAsync(495_000);
		finish();
		finish();

		await expect(observed).resolves.toContain("495s maximum");
		expect(budget.pause()).toBeUndefined();
		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe(createSubmitBudgetController, () => {
	it("should not renew an inactivity budget for repeated progress", async () => {
		expect.assertions(2);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 75_000,
			capacityBudgetMs: 405_000,
		});
		budget.progress("blockers:a\nb");
		await vi.advanceTimersByTimeAsync(70_000);
		budget.progress("blockers:a\nb");
		budget.progress("terminal:a");
		budget.progress("terminal:a");
		await vi.advanceTimersByTimeAsync(75_000);

		await expect(observed).resolves.toContain("75s inactivity limit");
		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
	});

	it("should stop changing blockers at the absolute capacity bound", async () => {
		expect.assertions(2);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 75_000,
			capacityBudgetMs: 405_000,
		});
		budget.progress("blockers:0");
		for (let elapsed = 70_000; elapsed <= 420_000; elapsed += 70_000) {
			await vi.advanceTimersByTimeAsync(70_000);
			budget.progress(`blockers:${String(elapsed)}`);
		}

		await vi.advanceTimersByTimeAsync(60_000);

		await expect(observed).resolves.toContain("480s maximum");
		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
	});

	it("should ignore progress after the submit settles", async () => {
		expect.assertions(2);

		useClock();
		const budget = createSubmitBudgetController({
			budgetMs: 75_000,
			cancelSubmitting: vi.fn<() => void>(() => {}),
			capacityBudgetMs: 405_000,
		});

		await expect(budget.raceAsync(Promise.resolve("accepted"))).resolves.toBe("accepted");

		budget.progress("late");
		budget.defer(60_000);

		expect(vi.getTimerCount()).toBe(0);
	});

	it("should preserve spent inactivity when excluding a quota wait", async () => {
		expect.assertions(3);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		budget.defer(60_000);
		await vi.advanceTimersByTimeAsync(89_999);

		expect(cancelSubmitting).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
		await expect(observed).resolves.toContain("90s inactivity limit");
	});

	it("should cap an enormous quota hint at the absolute deadline", async () => {
		expect.assertions(2);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		budget.defer(Number.MAX_VALUE);
		await vi.advanceTimersByTimeAsync(495_000);

		await expect(observed).resolves.toContain("495s maximum");
		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
	});

	it("should retain the original hard bound without a capacity allowance", async () => {
		expect.assertions(2);

		const { budget, cancelSubmitting, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 0,
		});
		budget.defer(60_000);
		await vi.advanceTimersByTimeAsync(90_000);

		await expect(observed).resolves.toContain("within 90s");
		expect(cancelSubmitting).toHaveBeenCalledExactlyOnceWith();
	});
});

function useClock(): void {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
}

function makePendingBudget(options: { budgetMs: number; capacityBudgetMs: number }) {
	useClock();
	const cancelSubmitting = vi.fn<() => void>();
	const budget = createSubmitBudgetController({ ...options, cancelSubmitting });
	const observed = budget.raceAsync(new Promise<never>(() => {})).catch(String);
	return { budget, cancelSubmitting, observed };
}

describe("submission duration", () => {
	it("should combine only explicitly bounded submission budgets", () => {
		expect.assertions(3);

		expect(maximumSubmitDuration({ submitBudget: 10, submitCapacityBudget: 20 })).toBe(30);
		expect(maximumSubmitDuration({ submitBudget: 10 })).toBe(10);
		expect(maximumSubmitDuration({})).toBeUndefined();
	});
});

describe("submission budget boundaries", () => {
	it("should renew inactivity only for new progress and leave settled timers closed", async () => {
		expect.assertions(4);

		const { budget, observed } = makePendingBudget({
			budgetMs: 90_000,
			capacityBudgetMs: 405_000,
		});
		const settled = vi.fn<(value: string) => void>();
		const complete = observed.then(settled);
		await vi.advanceTimersByTimeAsync(60_000);
		budget.progress("new blocker");
		await vi.advanceTimersByTimeAsync(30_000);
		budget.progress("new blocker");
		await vi.advanceTimersByTimeAsync(59_999);

		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await complete;

		expect(settled).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("90s inactivity limit"),
		);

		budget.defer(100_000);
		budget.progress("after settlement");

		expect(budget.pause()).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should preserve the hard bound when no capacity allowance exists", async () => {
		expect.assertions(2);

		const { budget, observed } = makePendingBudget({ budgetMs: 1234, capacityBudgetMs: 0 });

		expect(budget.pause()).toBeUndefined();

		budget.progress("ignored");
		budget.defer(5000);
		await vi.advanceTimersByTimeAsync(1234);

		await expect(observed).resolves.toBe(
			"Error: Open Cloud did not accept the task within 1s. Open Cloud may be throttling creates, or the place may have no task slots available.",
		);
	});

	it("should describe both limits when capacity allowance exists", async () => {
		expect.assertions(1);

		const { observed } = makePendingBudget({ budgetMs: 1000, capacityBudgetMs: 2000 });
		await vi.advanceTimersByTimeAsync(1000);

		await expect(observed).resolves.toBe(
			"Error: Open Cloud did not accept the task (1s inactivity limit; 3s maximum). Open Cloud may be throttling creates, or the place may have no task slots available.",
		);
	});
});

describe(waitForSubmitRetryAsync, () => {
	it("should resolve on abort and detach the listener", async () => {
		expect.assertions(3);

		useClock();
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const waiting = waitForSubmitRetryAsync(1000, controller.signal);
		controller.abort();

		await expect(waiting).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("should resolve at the requested time without a signal", async () => {
		expect.assertions(3);

		useClock();
		const settled = vi.fn<(value: void) => void>();
		const waiting = waitForSubmitRetryAsync(1000).then(settled);
		await vi.advanceTimersByTimeAsync(999);

		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		await waiting;

		expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe(combineSubmitSignals, () => {
	it("should preserve budget cancellation without a caller signal", () => {
		expect.assertions(1);

		const budget = new AbortController();

		expect(combineSubmitSignals(undefined, budget.signal)).toBe(budget.signal);
	});

	it.for([0, 1])("should abort when owner %s cancels", (owner) => {
		expect.assertions(2);

		const caller = new AbortController();
		const budget = new AbortController();
		const signal = combineSubmitSignals(caller.signal, budget.signal);
		const controller = [caller, budget][owner]!;
		controller.abort(owner);

		expect(signal.aborted).toBeTrue();
		expect(signal.reason).toBe(owner);
	});
});

describe(pauseBudgetWhileWaiting, () => {
	it("should pair admission starts and ends once while charging retry backoff", () => {
		expect.assertions(3);

		const resume = vi.fn<() => void>();
		const pause = vi.fn<() => () => void>(() => resume);
		const observer = pauseBudgetWhileWaiting({
			defer: vi.fn<(milliseconds: number) => void>(),
			pause,
			progress: vi.fn<(fingerprint: string) => void>(),
			raceAsync: async (value) => value,
		});
		observer({ phase: "ended", reason: "operation-capacity" });
		observer({ phase: "started", reason: "retry-delay" });

		expect(pause).not.toHaveBeenCalled();

		observer({ phase: "started", reason: "reported-budget" });
		observer({ phase: "ended", reason: "retry-delay" });
		observer({ phase: "ended", reason: "reported-budget" });
		observer({ phase: "ended", reason: "operation-queue" });

		expect(pause).toHaveBeenCalledExactlyOnceWith();
		expect(resume).toHaveBeenCalledExactlyOnceWith();
	});

	it("should tolerate admission without an additional capacity allowance", () => {
		expect.assertions(1);

		const pause = vi.fn<() => undefined>();
		const observer = pauseBudgetWhileWaiting({
			defer: vi.fn<(milliseconds: number) => void>(),
			pause,
			progress: vi.fn<(fingerprint: string) => void>(),
			raceAsync: async (value) => value,
		});
		observer({ phase: "started", reason: "operation-queue" });
		observer({ phase: "ended", reason: "operation-queue" });

		expect(pause).toHaveBeenCalledExactlyOnceWith();
	});
});
