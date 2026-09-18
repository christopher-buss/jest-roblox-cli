import type { HttpClient, HttpRequest, RequestConfig } from "@bedrock-rbx/ocale";
import { RateLimitError } from "@bedrock-rbx/ocale";

import { type } from "arktype";
import { setTimeout as delay } from "node:timers/promises";

const CAPACITY_POLL_MS = 5_000;
const CAPACITY_WAIT_MS = 60_000;
const MAX_BLOCKING_TASKS = 10;
const TERMINAL_STATES = new Set(["CANCELLED", "COMPLETE", "FAILED"]);
const capacityDetailsSchema = type({ code: "'RESOURCE_EXHAUSTED'", message: "string" });
const taskStateSchema = type({ state: "'CANCELLED'|'COMPLETE'|'FAILED'|'PROCESSING'|'QUEUED'" });
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export interface CapacityProgress {
	readonly fingerprint: string;
	readonly signal: AbortSignal | undefined;
}

export interface CapacitySubmitClientOptions {
	readonly onAdmissionWait?: (milliseconds: number) => void;
	readonly onCapacityProgress?: (progress: CapacityProgress) => void;
	readonly placeId: string;
	readonly universeId: string;
	readonly waitAsync?: WaitAsync;
}

type WaitAsync = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

/**
 * Delays a rejected task create until one of the tasks occupying the place
 * reaches a terminal state. The rejected create is safe to retry; task reads
 * remain on the undecorated transport and cannot recursively enter this wait.
 */
export function createCapacitySubmitClient(
	httpClient: HttpClient,
	options: CapacitySubmitClientOptions,
): HttpClient {
	const waitAsync = options.waitAsync ?? defaultWaitAsync;
	return {
		request: async (request, config) => {
			const result = await httpClient.request(request, config);
			const quotaWait = quotaWaitMs(request, result);
			if (quotaWait !== undefined) {
				options.onAdmissionWait?.(quotaWait);
			}

			const blockers = blockingTaskUrls({ options, request, result });
			if (blockers === undefined) {
				return result;
			}

			options.onCapacityProgress?.({
				fingerprint: `blockers:${blockers.join("\n")}`,
				signal: config.signal,
			});

			await waitForCapacityAsync({ blockers, config, httpClient, options, waitAsync });
			return result;
		},
	};
}

function quotaWaitMs(
	request: HttpRequest,
	result: Awaited<ReturnType<HttpClient["request"]>>,
): number | undefined {
	if (
		request.method !== "POST" ||
		!request.url.endsWith("/luau-execution-session-tasks") ||
		result.success ||
		!(result.err instanceof RateLimitError) ||
		result.err.remaining !== 0
	) {
		return undefined;
	}

	const milliseconds = result.err.retryAfterSeconds * 1000;
	return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function blockingTaskUrls({
	options,
	request,
	result,
}: {
	options: CapacitySubmitClientOptions;
	request: HttpRequest;
	result: Awaited<ReturnType<HttpClient["request"]>>;
}): Array<string> | undefined {
	if (request.method !== "POST" || !request.url.endsWith("/luau-execution-session-tasks")) {
		return undefined;
	}

	if (result.success || !(result.err instanceof RateLimitError)) {
		return undefined;
	}

	if (result.err.remaining === 0) {
		return undefined;
	}

	const details = capacityDetailsSchema(result.err.details);
	if (details instanceof type.errors) {
		return undefined;
	}

	const escapedUniverse = escapeRegExp(options.universeId);
	const escapedPlace = escapeRegExp(options.placeId);
	const taskPath = new RegExp(
		`universes/${escapedUniverse}/places/${escapedPlace}/versions/[1-9][0-9]*/luau-execution-sessions/${UUID}/tasks/${UUID}`,
		"giu",
	);
	const refs = details.message.match(taskPath) ?? [];
	const valid = [...new Set(refs.slice(-MAX_BLOCKING_TASKS))].sort();
	return valid.length === 0 ? undefined : valid.map((ref) => `/cloud/v2/${ref}?view=BASIC`);
}

function isAborted(signal: AbortSignal): boolean {
	return signal.aborted;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw signal.reason;
	}
}

async function observeBlockersOnceAsync({
	blockers,
	deadline,
	externalSignal,
	httpClient,
	observationConfig,
	onTerminal,
}: {
	blockers: ReadonlyArray<string>;
	deadline: AbortSignal;
	externalSignal: AbortSignal | undefined;
	httpClient: HttpClient;
	observationConfig: RequestConfig;
	onTerminal: (url: string) => void;
}): Promise<boolean> {
	for (const url of blockers) {
		throwIfAborted(externalSignal);
		const observed = await httpClient.request({ method: "GET", url }, observationConfig);
		if (isAborted(deadline) || !observed.success) {
			return true;
		}

		const task = taskStateSchema(observed.data.body);
		if (task instanceof type.errors) {
			return true;
		}

		if (TERMINAL_STATES.has(task.state)) {
			onTerminal(url);
			return true;
		}
	}

	return false;
}

async function waitOnceAsync({
	deadline,
	milliseconds,
	signal,
	waitAsync,
}: {
	deadline: AbortSignal;
	milliseconds: number;
	signal: AbortSignal;
	waitAsync: WaitAsync;
}): Promise<boolean> {
	try {
		await waitAsync(milliseconds, signal);
		return false;
	} catch (err) {
		if (isAborted(deadline)) {
			return true;
		}

		throw err;
	}
}

// eslint-disable-next-line flawless/max-lines-per-function -- one bounded observation lifecycle
async function waitForCapacityAsync({
	blockers,
	config,
	httpClient,
	options,
	waitAsync,
}: {
	blockers: ReadonlyArray<string>;
	config: RequestConfig;
	httpClient: HttpClient;
	options: CapacitySubmitClientOptions;
	waitAsync: WaitAsync;
}): Promise<void> {
	const deadlineController = new AbortController();
	const deadline = deadlineController.signal;
	const deadlineAt = Date.now() + CAPACITY_WAIT_MS;
	const deadlineTimer = setTimeout(() => {
		deadlineController.abort("capacity wait expired");
	}, CAPACITY_WAIT_MS);
	const signal =
		config.signal === undefined ? deadline : AbortSignal.any([config.signal, deadline]);
	const observationConfig = { ...config, signal };
	try {
		while (!isAborted(deadline)) {
			const shouldStop = await observeBlockersOnceAsync({
				blockers,
				deadline,
				externalSignal: config.signal,
				httpClient,
				observationConfig,
				onTerminal: (url) => {
					options.onCapacityProgress?.({
						fingerprint: `terminal:${url}`,
						signal: config.signal,
					});
				},
			});
			if (shouldStop) {
				return;
			}

			throwIfAborted(signal);
			const milliseconds = Math.min(CAPACITY_POLL_MS, deadlineAt - Date.now());
			if (milliseconds <= 0) {
				return;
			}

			options.onAdmissionWait?.(milliseconds);
			if (await waitOnceAsync({ deadline, milliseconds, signal, waitAsync })) {
				return;
			}
		}
	} finally {
		clearTimeout(deadlineTimer);
	}
}

async function defaultWaitAsync(ms: number, signal: AbortSignal | undefined): Promise<void> {
	await delay(ms, undefined, { signal });
}
