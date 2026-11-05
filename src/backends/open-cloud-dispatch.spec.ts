import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { envelope, scriptNaming, scriptResult } from "#test/mocks/spec-open-cloud.ts";
import type { BackendOptions, ProjectJob } from "./interface.ts";
import { dispatchJobsAsync } from "./open-cloud-dispatch.ts";

type ExecuteTask = Parameters<typeof dispatchJobsAsync>[0]["executeAsync"];

type ExecuteRequest = Parameters<ExecuteTask>[0];

type ExecuteHandler = (request: ExecuteRequest) => Promise<ScriptResult> | ScriptResult;

type ExecuteStep = () => Promise<ScriptResult> | ScriptResult;

interface ExecuteStub {
	executeAsync: ExecuteTask;
	executeCalls: Array<ExecuteRequest>;
}

function createExecuteStub(handler: ExecuteHandler): ExecuteStub {
	const executeCalls: Array<ExecuteRequest> = [];
	return {
		executeAsync: async (request) => {
			executeCalls.push(request);
			return handler(request);
		},
		executeCalls,
	};
}

async function dispatchAsync(stub: ExecuteStub, options: BackendOptions) {
	return dispatchJobsAsync({
		...options,
		executeAsync: stub.executeAsync,
		primaryConfig: options.jobs[0]!.config,
		version: { bootProven: true, versionNumber: 7 },
	});
}

function job(displayName: string): ProjectJob {
	return {
		config: createResolvedConfig(),
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	};
}

function successJest(): string {
	return JSON.stringify({ success: true });
}

function packageEntry(packageName: string) {
	return { jestOutput: successJest(), pkg: packageName };
}

/**
 * The packages a {@link scriptNaming} script carries.
 *
 * @param request - Request holding the script.
 * @returns The package names in the script.
 */
function requestedNames(request: ExecuteRequest): Array<string> {
	return request.script.split("entries:", 2)[1]!.split(",");
}

/**
 * An envelope answering exactly the packages a script asked for.
 *
 * @param request - Request holding the script.
 * @returns A result with one entry per requested package.
 */
function scriptedEntries(request: ExecuteRequest): ScriptResult {
	return scriptResult(envelope(requestedNames(request).map(packageEntry)));
}

/**
 * Answers every script with the packages it asked for, except one carrying
 * more than one entry and leading with `deferringHead` — that comes back
 * deferred, having run only the head.
 *
 * @param deferringHead - Package that leads the script to defer.
 * @returns The execute handler.
 */
function deferOnceExecute(deferringHead: string): ExecuteHandler {
	return (request): ScriptResult => {
		const requested = requestedNames(request);
		return requested.length > 1 && requested[0] === deferringHead
			? scriptResult(envelope([packageEntry(deferringHead)], { deferred: true }))
			: scriptedEntries(request);
	};
}

/**
 * The bucket whose script leads with `bailingHead` stops on it: one entry
 * back, flagged bailed and not deferred. Every other bucket answers in full.
 *
 * @param bailingHead - Package that leads the bailing bucket.
 * @returns The execute handler.
 */
function bailingBucketExecute(bailingHead: string): ExecuteHandler {
	return (request): ScriptResult => {
		return requestedNames(request)[0] === bailingHead
			? scriptResult(envelope([packageEntry(bailingHead)], { bailed: true }))
			: scriptedEntries(request);
	};
}

/**
 * Runs `steps[callIndex]`, repeating the final step once the list is
 * exhausted.
 *
 * @param steps - Results to give, one per call.
 * @returns The execute handler.
 */
function stepExecute(steps: Array<ExecuteStep>): ExecuteHandler {
	let callIndex = 0;
	return (): Promise<ScriptResult> | ScriptResult => {
		const step = steps[Math.min(callIndex, steps.length - 1)]!;
		callIndex += 1;
		return step();
	};
}

describe(dispatchJobsAsync, () => {
	it("should pin every task to the run's version and the primary job's timeout", async () => {
		expect.assertions(1);

		const stub = createExecuteStub(() => {
			return scriptResult(envelope([{ jestOutput: successJest() }]));
		});
		await dispatchAsync(stub, { jobs: [job("alpha")], scriptOverride: "custom" });

		expect(stub.executeCalls).toStrictEqual([
			{
				script: "custom",
				timeout: createResolvedConfig().timeout,
				version: { bootProven: true, versionNumber: 7 },
			},
		]);
	});

	it("should flatten static buckets back into job order with each task's game output", async () => {
		expect.assertions(1);

		const success = { jestOutput: successJest() };
		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([success, success]), "first"),
				() => scriptResult(envelope([success]), "second"),
			]),
		);

		const { rawResults } = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta"), job("gamma")],
			parallel: 2,
		});

		expect(rawResults.map((raw) => raw.fallbackGameOutput)).toStrictEqual([
			"first",
			"second",
			"first",
		]);
	});

	it("should throw when a static bucket returns no outputs", async () => {
		expect.assertions(1);

		const stub = createExecuteStub(() => ({ durationMs: 0, outputs: [] }));

		await expect(dispatchAsync(stub, { jobs: [job("alpha")] })).rejects.toThrow(
			"No test results in output. Got: []",
		);
	});

	it("should fan one work-stealing script out and collect every package", async () => {
		expect.assertions(2);

		const stub = createExecuteStub(() => scriptResult(envelope([packageEntry("alpha")])));

		const { rawResults } = await dispatchAsync(stub, {
			jobs: [job("alpha")],
			scriptOverride: "stealing-script",
			workStealing: true,
		});

		expect(stub.executeCalls.map((call) => call.script)).toStrictEqual(["stealing-script"]);
		expect(rawResults).toHaveLength(1);
	});

	it("should re-send a deferring bucket's leftovers to that bucket alone", async () => {
		expect.assertions(2);

		// Each bucket owns its own deferral chain: the one that filled its
		// envelope re-sends only what it left behind, and its sibling is
		// untouched by the extra round.
		const stub = createExecuteStub(deferOnceExecute("alpha"));

		const results = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
			parallel: 2,
			scriptFactory: scriptNaming,
		});

		expect(results.rawResults).toHaveLength(4);
		expect(stub.executeCalls.map(requestedNames)).toStrictEqual([
			["alpha", "gamma"],
			["beta", "delta"],
			["gamma"],
		]);
	});

	it("should keep a sibling bucket's results when one bucket bails", async () => {
		expect.assertions(2);

		// A bail is task-local on this path — there is no signal map to
		// broadcast it — so it stops the bucket that hit it and no other.
		// The sibling still runs its whole share, and the only jobs
		// reported skipped are the tail the bailing bucket never reached.
		const stub = createExecuteStub(bailingBucketExecute("alpha"));

		const results = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta"), job("gamma"), job("delta")],
			parallel: 2,
			scriptFactory: scriptNaming,
		});

		// gamma alone: it shared alpha's bucket and never ran, while beta
		// and delta came back from the sibling that carried on.
		expect(results.bailedJobIndices).toStrictEqual([2]);
		expect(results.rawResults).toHaveLength(3);
	});

	it("should re-send the entries a deferring task left behind", async () => {
		expect.assertions(3);

		/**
		 * A task that fills its envelope has no queue to leave the rest in
		 * once work-stealing is out of reach. The backend has to rebuild a
		 * script from what did not come back, or those packages are lost.
		 */
		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
				() => scriptResult(envelope([packageEntry("beta"), packageEntry("gamma")])),
			]),
		);

		const jobs = [job("alpha"), job("beta"), job("gamma")];
		const results = await dispatchAsync(stub, { jobs, scriptFactory: scriptNaming });

		expect(results.rawResults).toHaveLength(3);
		expect(stub.executeCalls).toHaveLength(2);
		// Only the two that did not come back the first time.
		expect(requestedNames(stub.executeCalls[1]!)).toStrictEqual(["beta", "gamma"]);
	});

	it("should stop after a non-deferred workspace envelope", async () => {
		expect.assertions(2);

		const stub = createExecuteStub(() => {
			return scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")]));
		});

		const result = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta")],
			scriptFactory: () => "workspace-script",
		});

		expect(stub.executeCalls).toHaveLength(1);
		expect(result.rawResults).toHaveLength(2);
	});

	it("should stop when a deferred workspace envelope covered every job", async () => {
		expect.assertions(2);

		const stub = createExecuteStub(() => {
			return scriptResult(
				envelope([packageEntry("alpha"), packageEntry("beta")], { deferred: true }),
			);
		});

		const result = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta")],
			scriptFactory: () => "workspace-script",
		});

		expect(stub.executeCalls).toHaveLength(1);
		expect(result.rawResults).toHaveLength(2);
	});

	it("should preserve bail evidence across deferred workspace envelopes", async () => {
		expect.assertions(2);

		const stub = createExecuteStub(
			stepExecute([
				() => {
					return scriptResult(
						envelope([packageEntry("alpha")], { bailed: true, deferred: true }),
					);
				},
				() => scriptResult(envelope([packageEntry("beta")])),
			]),
		);

		const result = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta"), job("gamma")],
			scriptFactory: () => "workspace-script",
		});

		expect(stub.executeCalls).toHaveLength(2);
		expect(result.bailedJobIndices).toStrictEqual([2]);
	});

	it("should stop re-sending when a task covers nothing new", async () => {
		expect.assertions(2);

		/**
		 * A task that defers without running anything cannot be answered by
		 * sending it the same work again. Failing on the missing packages
		 * beats spending one task per job to reach the same place.
		 */
		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
			]),
		);

		await expect(
			dispatchAsync(stub, {
				jobs: [job("alpha"), job("beta"), job("gamma")],
				scriptFactory: () => "retry-script",
			}),
		).rejects.toThrow("beta, gamma");

		expect(stub.executeCalls).toHaveLength(2);
	});

	it("should fail a workspace task that returns no output at all", async () => {
		expect.assertions(1);

		const stub = createExecuteStub(() => ({ durationMs: 1, outputs: [] }));

		await expect(
			dispatchAsync(stub, {
				jobs: [job("alpha")],
				scriptFactory: () => "factory-built",
			}),
		).rejects.toThrow("No test results in output");
	});

	it("should throw when the bucket envelope length does not match the job count", async () => {
		expect.assertions(1);

		const stub = createExecuteStub(() => {
			return scriptResult(
				envelope([{ jestOutput: successJest() }, { jestOutput: successJest() }]),
			);
		});

		await expect(dispatchAsync(stub, { jobs: [job("alpha")] })).rejects.toThrow(
			/Open Cloud backend returned 2 entries but bucket had 1 jobs/,
		);
	});
});
