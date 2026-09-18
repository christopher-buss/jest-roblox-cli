import { afterAll, beforeAll, describe, expect, it } from "@rbxts/jest-globals";

const CASE_COUNT = 120;
const CASE_SECONDS = 0.1;
const cases = new Array<number>();
for (let index = 0; index < CASE_COUNT; index += 1) cases.push(index);

describe("scheduler fairness", () => {
	let completedCallbacks = 0;
	let completedCases = 0;
	let heartbeats = 0;
	let connection: RBXScriptConnection;
	beforeAll(() => {
		connection = game.GetService("RunService").Heartbeat.Connect(() => {
			heartbeats += 1;
		});
	});
	afterAll(() => {
		connection.Disconnect();
	});

	// Every case stays below Jest's timeout; the batch exceeds the engine's
	// uninterrupted-resumption allowance unless Circus yields between cases.
	it.each(cases)("finishes bounded CPU case %i", () => {
		task.defer(() => {
			completedCallbacks += 1;
		});
		const startedAt = os.clock();
		while (os.clock() - startedAt < CASE_SECONDS) {
			// Deliberately synchronous: only the runner may yield this batch.
		}
		completedCases += 1;
		expect(os.clock() - startedAt).toBeGreaterThanOrEqual(CASE_SECONDS);
	});

	it("services deferred callbacks and Heartbeat during the CPU batch", () => {
		expect(completedCases).toBe(CASE_COUNT);
		expect(completedCallbacks).toBeGreaterThan(0);
		expect(heartbeats).toBeGreaterThan(0);
		warn("scheduler fairness marker");
	});
});
