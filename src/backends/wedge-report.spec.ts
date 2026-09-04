import { PollTimeoutError } from "@bedrock-rbx/ocale";

import { describe, expect, it } from "vitest";

import type { TestProgressEntry, TestProgressReader } from "../memory-store/test-progress.ts";
import { rethrowWedgeAsync } from "./wedge-report.ts";

function entry(overrides: Partial<TestProgressEntry> = {}): TestProgressEntry {
	return {
		elapsedMs: 42_000,
		state: "started",
		testFilePath: "ReplicatedStorage/shared/wedge.spec",
		testName: "wedges > never returns",
		...overrides,
	};
}

function reader(entries: Array<TestProgressEntry>): TestProgressReader {
	return {
		readAllAsync: async () => entries,
	};
}

function timeoutError(): Error {
	return new Error("Execution timed out: Roblox never reported a terminal state", {
		cause: new PollTimeoutError("poll budget exhausted", { timeoutMs: 300_000 }),
	});
}

/**
 * What the run reports for a wedge carrying `entries` — the banner as a
 * whole, which is the only way the lines below reach a user.
 */
async function bannerAsync(entries: Array<TestProgressEntry>): Promise<string> {
	const caught: unknown = await rethrowWedgeAsync(timeoutError(), reader(entries)).catch(
		(err: unknown) => err,
	);
	return caught instanceof Error ? caught.message : String(caught);
}

describe("wedge banner", () => {
	it("should name the test that started and never completed", async () => {
		expect.assertions(1);

		await expect(bannerAsync([entry()])).resolves.toContain(
			"ReplicatedStorage/shared/wedge.spec › wedges > never returns — started 42.0s in, never completed",
		);
	});

	it("should report a finished test as finished", async () => {
		expect.assertions(1);

		await expect(bannerAsync([entry({ state: "completed" })])).resolves.toContain(
			"completed 42.0s in",
		);
	});

	/**
	 * The runtime throttles its writes, so a test that began just after the
	 * last record landed leaves none of its own. Naming the record's test
	 * outright would be wrong exactly when the test before the wedge was fast.
	 */
	it("should hedge the verdict rather than name the test outright", async () => {
		expect.assertions(2);

		const banner = await bannerAsync([entry()]);

		expect(banner).toContain("one shortly after it in that file");
		expect(banner).not.toContain("the wedge is that test.");
	});

	// The banner is one message, and every line of it has to survive being
	// joined onto the timeout's own text — a separator that is not a newline
	// runs the record and the hedge together into one unreadable line.
	it("should render one line per record and per hedge sentence", async () => {
		expect.assertions(1);

		const banner = await bannerAsync([entry()]);

		expect(banner.split("\n")).toStrictEqual([
			"Execution timed out: Roblox never reported a terminal state",
			"  The task never came back, and the last thing the Roblox VM published was:",
			"    ReplicatedStorage/shared/wedge.spec › wedges > never returns — started 42.0s in, never completed",
			"  The runtime publishes about one record a second, so the wedge is that",
			"  test or one shortly after it in that file: a test that never yields",
			"  starves every other coroutine, so nothing later could publish.",
		]);
	});

	it("should say no test had begun when the record carries only a file", async () => {
		expect.assertions(1);

		await expect(bannerAsync([entry({ testName: "" })])).resolves.toContain(
			"ReplicatedStorage/shared/wedge.spec — started 42.0s in, before its first test",
		);
	});

	/**
	 * The map is keyed by a GUID each task makes for itself, so the read order
	 * says nothing about which task was dispatched first — a numbered list
	 * would claim an order the run does not have.
	 */
	it("should list every task without implying an order", async () => {
		expect.assertions(3);

		const banner = await bannerAsync([
			entry({ testFilePath: "a.spec" }),
			entry({ testFilePath: "b.spec" }),
		]);

		expect(banner).toContain("in no particular order");
		expect(banner).toContain("a.spec");
		expect(banner).toContain("b.spec");
	});

	/**
	 * The map is shared by every task on the run, so a sibling that returned
	 * normally has a record in it too. Nothing correlates a record to the task
	 * that wrote it, so a banner claiming every listed task wedged would report
	 * healthy tasks as failures.
	 */
	it("should not claim every task with a record wedged", async () => {
		expect.assertions(2);

		const banner = await bannerAsync([
			entry({ testFilePath: "a.spec" }),
			entry({ testFilePath: "b.spec" }),
		]);

		expect(banner).toContain("At least one task never came back");
		expect(banner).not.toContain("The tasks never came back");
	});
});

describe(rethrowWedgeAsync, () => {
	it("should attach the last-seen test to a poll timeout", async () => {
		expect.assertions(2);

		const rethrown = rethrowWedgeAsync(timeoutError(), reader([entry()]));

		await expect(rethrown).rejects.toThrow("Execution timed out");
		await expect(rethrown).rejects.toThrow("wedges > never returns");
	});

	// The annotated error replaces the original on the way out, so the
	// original has to ride along as `cause` — the formatters walk that chain
	// to render the backend failure underneath the banner.
	it("should carry the original failure as the cause", async () => {
		expect.assertions(1);

		const original = timeoutError();
		const caught = await rethrowWedgeAsync(original, reader([entry()])).catch(
			(err: unknown) => err,
		);

		expect(caught).toHaveProperty("cause", original);
	});

	it("should rethrow untouched when the failure is not a poll timeout", async () => {
		expect.assertions(1);

		const original = new Error("permission denied");
		const caught = await rethrowWedgeAsync(original, reader([entry()])).catch(
			(err: unknown) => err,
		);

		expect(caught).toBe(original);
	});

	it("should rethrow untouched when there is no reader", async () => {
		expect.assertions(1);

		const original = timeoutError();
		const caught = await rethrowWedgeAsync(original, undefined).catch((err: unknown) => err);

		expect(caught).toBe(original);
	});

	it("should rethrow a thrown non-Error untouched", async () => {
		expect.assertions(1);

		const caught = await rethrowWedgeAsync("boom", reader([entry()])).catch(
			(err: unknown) => err,
		);

		expect(caught).toBe("boom");
	});

	it("should rethrow untouched when the runtime published nothing", async () => {
		expect.assertions(1);

		const original = timeoutError();
		const caught = await rethrowWedgeAsync(original, reader([])).catch((err: unknown) => err);

		expect(caught).toBe(original);
	});

	it("should rethrow the original failure when the progress map cannot be read", async () => {
		expect.assertions(1);

		const original = timeoutError();
		const caught = await rethrowWedgeAsync(original, {
			readAllAsync: async () => {
				throw new Error("no memory-store scope");
			},
		}).catch((err: unknown) => err);

		expect(caught).toBe(original);
	});
});
