import type { ExecutionClaimObservation } from "../luau/execution-claim.ts";

/** Submission events the boot watch reacts to. */
export interface SubmissionLifecycle {
	/** Arms the boot watch once the submission is accepted. */
	accepted(): void;
}

/** A boot observation, tagged with the watch generation that made it. */
export type WatchedObservation = BootObservation & {
	/** Identity of the arm that made the observation. */
	generation: object;
};

type BootObservation = { status: "failed" | "missing" } | { status: "found" };

/**
 * Watches for an execution claim after a boot delay.
 *
 * @param options - Claim key, delay, reader, and submission mode.
 * @returns Controls for the watch and a promise of its latest observation.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- timer generation and claim read form one lifecycle
export function createBootWatch({
	key,
	bootWatchMs,
	readClaimAsync,
	watchesSubmission,
}: {
	/** Delay before the claim is read, in milliseconds. */
	bootWatchMs: number;
	/** Key of the execution claim to read. */
	key: string;
	/** Reads the claim; when absent, the watch reports `found`. */
	readClaimAsync:
		| ((key: string, signal: AbortSignal) => Promise<ExecutionClaimObservation>)
		| undefined;
	/** When true, the watch arms on submission acceptance, not at once. */
	watchesSubmission: boolean;
}): {
	/** Stops the watch for good. */
	cancel: () => void;
	/** Reports whether an observation comes from the current arm. */
	isCurrent: (observed: WatchedObservation) => boolean;
	/** Resolves with the observation of the current arm. */
	promise: Promise<WatchedObservation>;
	/** Submission events that re-arm the watch. */
	submission: SubmissionLifecycle;
} {
	let generation = {};
	let observation: AbortController | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let isCanceled = false;
	let settled = Promise.withResolvers<WatchedObservation>();
	let resolvedGeneration: object | undefined;

	function currentSettled(): PromiseWithResolvers<WatchedObservation> {
		if (resolvedGeneration !== undefined && resolvedGeneration !== generation) {
			settled = Promise.withResolvers<WatchedObservation>();
			resolvedGeneration = undefined;
		}

		return settled;
	}

	function invalidate(): object {
		generation = {};
		clearTimeout(timer);
		observation?.abort();
		observation = undefined;
		return generation;
	}

	function arm(): void {
		if (isCanceled) {
			return;
		}

		const armedGeneration = invalidate();
		timer = setTimeout(() => {
			void observeAsync(armedGeneration);
		}, bootWatchMs);
	}

	async function observeAsync(armedGeneration: object): Promise<void> {
		observation = new AbortController();
		let result: BootObservation;
		try {
			const claim =
				readClaimAsync === undefined
					? ({ status: "found" } satisfies BootObservation)
					: await readClaimAsync(key, observation.signal);
			result = { status: claim.status };
		} catch {
			result = { status: "failed" };
		}

		if (!isCanceled && generation === armedGeneration) {
			currentSettled().resolve({ ...result, generation: armedGeneration });
			resolvedGeneration = armedGeneration;
		}
	}

	if (!watchesSubmission) {
		arm();
	}

	return {
		cancel: () => {
			isCanceled = true;
			invalidate();
		},
		isCurrent: (observed) => observed.generation === generation,
		get promise() {
			return currentSettled().promise;
		},
		submission: { accepted: arm },
	};
}
