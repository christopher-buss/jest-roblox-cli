import type { TestProgressEntry, TestProgressReader } from "../memory-store/test-progress.ts";
import { errorChain, isPollTimeout } from "../utils/error-chain.ts";

/**
 * Rethrow a dispatch failure, naming the test the run wedged on when it was a
 * poll timeout and the runtime left a heartbeat behind.
 *
 * Everything else passes through untouched. A 401 or a 429 says something
 * about the request rather than about a test, and a run whose progress map is
 * unreadable (no `memory-store` scope on the key) is better served by its
 * original error than by a complaint about a diagnostic channel it never asked
 * for.
 *
 * @param err - The failure the dispatch settled on.
 * @param reader - The run's progress map, or undefined when it kept none.
 * @throws The original error, or one carrying it as `cause` and the last-seen
 *   test in its message.
 */
export async function rethrowWedgeAsync(
	err: unknown,
	reader: TestProgressReader | undefined,
): Promise<never> {
	// The head is what the annotation is written onto. A thrown non-Error has
	// no chain at all, so it can carry neither a poll timeout nor a message to
	// append to.
	const head = errorChain(err)[0];
	if (reader === undefined || head === undefined || !isPollTimeout(err)) {
		throw err;
	}

	let entries: Array<TestProgressEntry>;
	try {
		entries = await reader.readAllAsync();
	} catch {
		throw err;
	}

	const lines = describeWedgeProgress(entries);
	if (lines.length === 0) {
		throw err;
	}

	throw new Error([head.message, ...lines].join("\n"), { cause: err });
}

/** One record as a line: where the run was, and how far into the task. */
function describeEntry(entry: TestProgressEntry): string {
	const elapsed = `${(entry.elapsedMs / 1000).toFixed(1)}s in`;
	if (entry.testName === "") {
		return `${entry.testFilePath} — started ${elapsed}, before its first test`;
	}

	const suffix =
		entry.state === "started" ? `started ${elapsed}, never completed` : `completed ${elapsed}`;
	return `${entry.testFilePath} › ${entry.testName} — ${suffix}`;
}

/**
 * Turn the runtime's last heartbeat into the lines that go under a timeout.
 *
 * A wedge is the one failure Roblox describes with nothing at all: the task
 * stays `PROCESSING` past every deadline and returns no output, so the run's
 * only evidence is what the VM managed to publish before it stopped
 * publishing. One record per task, in the order the map handed them back.
 *
 * @param entries - The progress records the run's tasks left behind.
 * @returns Lines naming the last test each task reached, or none when the
 *   runtime published nothing.
 */
function describeWedgeProgress(entries: ReadonlyArray<TestProgressEntry>): Array<string> {
	if (entries.length === 0) {
		return [];
	}

	// Deliberately hedged, and hedged the same way whether the last record
	// says started or completed. The runtime throttles its writes to about one
	// a second, so a test that began just after the last one landed leaves no
	// record of its own — which makes the *file* exact and the *test* a lower
	// bound. A verdict that named the test outright would be wrong exactly
	// when the test before the wedge was fast, which is the common case.
	const hedge = [
		"  The runtime publishes about one record a second, so the wedge is that",
		"  test or one shortly after it in that file: a test that never yields",
		"  starves every other coroutine, so nothing later could publish.",
	];

	if (entries.length === 1) {
		return [
			"  The task never came back, and the last thing the Roblox VM published was:",
			...entries.map((entry) => `    ${describeEntry(entry)}`),
			...hedge,
		];
	}

	// The map is shared by every task on the run, and a task that returned
	// normally leaves its last record behind just as a wedged one does. The
	// read cannot tell them apart — nothing correlates a record to the task
	// that wrote it — so the list is every task's last record, and only the
	// timeout itself says that at least one of them never came back.
	//
	// In no order worth naming either: the map is keyed by a GUID each task
	// makes for itself, so the read order says nothing about dispatch order.
	return [
		"  At least one task never came back. Every task on this run published a",
		"  last record, in no particular order — a task that finished is not",
		"  wedged, and nothing here says which is which:",
		...entries.map((entry) => `    ${describeEntry(entry)}`),
		"  The runtime publishes about one record a second, so the wedge is one of",
		"  these tests or one shortly after it in that record's file: a test that",
		"  never yields starves every other coroutine, so nothing later could",
		"  publish.",
	];
}
