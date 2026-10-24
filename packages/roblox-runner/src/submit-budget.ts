import type { AdmissionWaitObserver } from "@bedrock-rbx/ocale";

/**
 * Tracks inactivity and capacity time until submission settles.
 */
export interface SubmitBudgetController {
	/**
	 * Credit a validated wait without extending the absolute deadline.
	 *
	 * @param milliseconds - Validated admission wait to credit against inactivity.
	 */
	defer(milliseconds: number): void;
	/**
	 * Suspend inactivity until the returned idempotent resume callback runs.
	 *
	 * @returns Idempotent resume callback, or undefined when settled or capacity time is disabled.
	 */
	pause(): (() => void) | undefined;
	/**
	 * Renew inactivity for previously unseen capacity evidence.
	 *
	 * @param fingerprint - Canonical blocker or terminal-event identity; repeats grant no time.
	 */
	progress(fingerprint: string): void;
	/**
	 * Bound submission while cleaning up its timer on every settlement.
	 *
	 * @param submitting - In-flight SDK submission whose settlement closes the timer.
	 * @returns Submission value if accepted before the budget expires.
	 * @template T
	 */
	raceAsync<T>(submitting: Promise<T>): Promise<T>;
}

const SUBMIT_EXPIRED = "submit-budget-expired";

/**
 * Optional host submission budgets in milliseconds.
 */
export interface SubmitDurationOptions {
	/**
	 * Maximum submission inactivity in milliseconds.
	 */
	submitBudget?: number;
	/**
	 * Additional absolute allowance for SDK and capacity admission waits.
	 */
	submitCapacityBudget?: number;
}

/**
 * Bound local submission work. Aborting a request cannot undo a task Roblox
 * already accepted.
 * @param options - Inactivity limit, absolute capacity allowance and cancellation callback.
 * @returns Controller enforcing both inactivity and absolute submission limits.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- timer lifecycle is one state machine
export function createSubmitBudgetController({
	budgetMs,
	cancelSubmitting,
	capacityBudgetMs,
}: {
	budgetMs: number;
	cancelSubmitting: () => void;
	capacityBudgetMs: number;
}): SubmitBudgetController {
	const maximumMs = budgetMs + capacityBudgetMs;
	const startedAt = Date.now();
	let inactivityDeadline = startedAt + budgetMs;
	const expired = Promise.withResolvers<typeof SUBMIT_EXPIRED>();
	const progress = new Set<string>();
	let timer: ReturnType<typeof setTimeout>;
	let isSettled = false;
	let waiting = 0;
	let waitingSince = startedAt;

	function arm(): void {
		clearTimeout(timer);
		const remainingMaximum = maximumMs - (Date.now() - startedAt);
		timer = setTimeout(
			() => {
				expired.resolve(SUBMIT_EXPIRED);
			},
			waiting > 0
				? remainingMaximum
				: Math.min(inactivityDeadline - Date.now(), remainingMaximum),
		);
	}

	arm();
	return {
		defer(milliseconds) {
			if (isSettled) {
				return;
			}

			inactivityDeadline = Math.min(startedAt + maximumMs, inactivityDeadline + milliseconds);
			arm();
		},
		pause() {
			if (isSettled || capacityBudgetMs === 0) {
				return;
			}

			if (waiting === 0) {
				waitingSince = Date.now();
			}

			waiting += 1;
			arm();
			let hasResumed = false;
			return () => {
				if (hasResumed || isSettled) {
					return;
				}

				hasResumed = true;
				waiting -= 1;
				if (waiting === 0) {
					inactivityDeadline += Date.now() - waitingSince;
					arm();
				}
			};
		},
		progress(nextFingerprint) {
			if (isSettled || progress.has(nextFingerprint)) {
				return;
			}

			progress.add(nextFingerprint);
			inactivityDeadline = Date.now() + budgetMs;
			waitingSince = Date.now();
			arm();
		},
		async raceAsync<T>(submitting: Promise<T>): Promise<T> {
			try {
				const outcome: typeof SUBMIT_EXPIRED | { value: T } = await Promise.race([
					submitting.then((value) => ({ value })),
					expired.promise,
				]);
				if (outcome === SUBMIT_EXPIRED) {
					cancelSubmitting();
					if (capacityBudgetMs === 0) {
						throw new Error(
							`Open Cloud did not accept the task within ${describeSeconds(budgetMs)}. ` +
								"Open Cloud may be throttling creates, or the place may have no task slots available.",
						);
					}

					throw new Error(
						"Open Cloud did not accept the task " +
							`(${describeSeconds(budgetMs)} inactivity limit; ${describeSeconds(maximumMs)} maximum). ` +
							"Open Cloud may be throttling creates, " +
							"or the place may have no task slots available.",
					);
				}

				return outcome.value;
			} finally {
				isSettled = true;
				clearTimeout(timer);
			}
		},
	};
}

/**
 * Holds the submit budget open while the SDK queues or honours a reported
 * budget. The SDK never nests one request's waits, so a single resume matches
 * each `started` to its `ended`. A `retry-delay` stays charged: it covers 5xx
 * backoff, and the 429 `retry-after` is credited through `defer` already.
 * @param budget - Inactivity and absolute capacity allowance.
 * @returns Observer pairing SDK admission starts and ends.
 */
export function pauseBudgetWhileWaiting(budget: SubmitBudgetController): AdmissionWaitObserver {
	let resume: (() => void) | undefined;
	return ({ phase, reason }) => {
		if (reason === "retry-delay") {
			return;
		}

		if (phase === "started") {
			resume = budget.pause();
			return;
		}

		resume?.();
		resume = undefined;
	};
}

/**
 * Wait `ms`, or less when `signal` aborts first.
 * @param ms - Milliseconds requested by the caller.
 * @param signal - Cancellation that resolves this wait early.
 */
export async function waitForSubmitRetryAsync(ms: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		}

		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish);
	});
}

/**
 * Maximum wall time of an explicitly budgeted task submission.
 * @param options - Submission inactivity and additional capacity allowances.
 * @returns Combined submission allowance, or undefined for unbudgeted submissions.
 */
export function maximumSubmitDuration(
	options: SubmitDurationOptions & { submitBudget: number },
): number;
export function maximumSubmitDuration(options: SubmitDurationOptions): number | undefined;
export function maximumSubmitDuration(options: SubmitDurationOptions): number | undefined {
	return options.submitBudget === undefined
		? undefined
		: options.submitBudget + (options.submitCapacityBudget ?? 0);
}

/**
 * Combine caller cancellation with the host submission budget.
 * @param caller - Optional caller observation signal.
 * @param budget - Host submission-budget cancellation signal.
 * @returns A signal aborted when either owner aborts.
 */
export function combineSubmitSignals(
	caller: AbortSignal | undefined,
	budget: AbortSignal,
): AbortSignal {
	return caller === undefined ? budget : AbortSignal.any([caller, budget]);
}

function describeSeconds(ms: number): string {
	return `${String(Math.round(ms / 1000))}s`;
}
