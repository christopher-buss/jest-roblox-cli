import type { JestResult } from "@isentinel/jest-roblox/api";
import { OcaleRunner, TaskStallError } from "@isentinel/roblox-runner";

import * as path from "node:path";
import process from "node:process";
import type { TestContext } from "vitest";
import { assert, describe, expect, it } from "vitest";

import { taskEnvelopeSchema } from "#src/protocol/envelope.ts";
import { MAXIMUM_SUBMIT_MS } from "#test/e2e/live/live-budgets.ts";
import { IS_LIVE } from "#test/e2e/live/live-gate.ts";
import {
	type FakeOpenCloudTask,
	startFakeOpenCloudServerAsync,
} from "#test/harness/fake-open-cloud.ts";
import { skipOnQuotaAsync } from "#test/setup/quota-skip.ts";

// Each assertion runs twice through the CLI's own Open Cloud client: once
// against the in-process fake, once against live `apis.roblox.com` (gated by
// JEST_ROBLOX_LIVE=1 plus credentials). If the fake drifts from the live wire,
// one branch fails.

const TASK_TIMEOUT_MS = 10_000;
const TASK_TEST_TIMEOUT_MS = MAXIMUM_SUBMIT_MS + 120_000;

const PLACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place/game.rbxl");

interface ContractCase {
	/** Starts a fresh fake seeded with the tasks; live ignores them. */
	createRunnerAsync: (tasks: Array<FakeOpenCloudTask>) => Promise<OcaleRunner>;
}

const liveCase = resolveLiveCase();
const fake: ContractCase = {
	createRunnerAsync: async (tasks) => {
		const server = await startFakeOpenCloudServerAsync(tasks);
		return new OcaleRunner(
			{ apiKey: "test-api-key", placeId: "456", universeId: "123" },
			{ baseUrl: server.baseUrl },
		);
	},
};
const fakeEntry = { name: "fake", settleTaskAsync: awaitTaskAsync, testCase: fake };
const cases =
	liveCase === undefined
		? [fakeEntry]
		: [fakeEntry, { name: "live", settleTaskAsync: skipOnQuotaAsync, testCase: liveCase }];

describe.for(cases)("open Cloud contract ($name)", ({ settleTaskAsync, testCase }) => {
	it(
		"should return a numeric versionNumber from a place upload",
		{ timeout: MAXIMUM_SUBMIT_MS + 5000 },
		async () => {
			expect.assertions(1);

			const runner = await testCase.createRunnerAsync([{ jestOutput: "" }]);
			const upload = await runner.uploadPlaceAsync({ placeFilePath: PLACE_FIXTURE_PATH });

			expect(upload.versionNumber).toBeNumber();
		},
	);

	it(
		"should return an envelope-shaped first output when the script completes",
		async (context) => {
			expect.assertions(3);

			const runner = await testCase.createRunnerAsync([
				// Fake-only: the fake wraps `jestOutput` into the envelope. Live
				// runs the script, which returns the envelope itself.
				{ jestOutput: JSON.stringify(buildPassingJestPayload()) },
			]);
			const result = await settleTaskAsync(
				context,
				executeOnceRecoveredAsync(runner, buildSuccessLuauScript()),
			);
			const [envelopeRaw, ...rest] = result.outputs;

			assert(envelopeRaw !== undefined, "the task returned no output");
			const envelope = taskEnvelopeSchema.assert(JSON.parse(envelopeRaw));

			expect(envelope.entries.map((entry) => entry.jestOutput)).not.toContain("");
			expect(rest).toSatisfyAll((output: unknown) => typeof output === "string");
			expect(rest.length).toBeLessThanOrEqual(1);
		},
		TASK_TEST_TIMEOUT_MS,
	);

	it(
		"should reject with the task's failure when the script errors",
		async (context) => {
			expect.assertions(1);

			const runner = await testCase.createRunnerAsync([
				{ errorMessage: "contract-failure", jestOutput: "", state: "FAILED" },
			]);
			const run = settleTaskAsync(
				context,
				executeOnceRecoveredAsync(runner, 'error("contract-failure")'),
			);

			await expect(run).rejects.toThrow(/Roblox task failed[\s\S]*contract-failure/);
		},
		TASK_TEST_TIMEOUT_MS,
	);
});

function resolveLiveCase(): ContractCase | undefined {
	const apiKey = process.env["ROBLOX_OPEN_CLOUD_API_KEY"] ?? "";
	const universeId = process.env["ROBLOX_UNIVERSE_ID"] ?? "";
	const placeId = process.env["ROBLOX_PLACE_ID"] ?? "";
	if (!IS_LIVE || apiKey === "" || universeId === "" || placeId === "") {
		return undefined;
	}

	return {
		createRunnerAsync: async () => new OcaleRunner({ apiKey, placeId, universeId }),
	};
}

async function executeOnceRecoveredAsync(runner: OcaleRunner, script: string) {
	try {
		return await runner.executeScriptAsync({ script, timeout: TASK_TIMEOUT_MS });
	} catch (err) {
		if (!(err instanceof TaskStallError)) {
			throw err;
		}

		return err.readResultAsync();
	}
}

async function awaitTaskAsync<T>(_context: TestContext, run: Promise<T>): Promise<T> {
	return run;
}

function buildPassingJestPayload(): JestResult {
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime: 0,
		success: true,
		testResults: [],
	};
}

function buildSuccessLuauScript(): string {
	const envelope = {
		entries: [{ jestOutput: JSON.stringify(buildPassingJestPayload()), jobIndex: 0 }],
	};

	return `return ${JSON.stringify(JSON.stringify(envelope))}`;
}
