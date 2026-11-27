import type { ScriptResult } from "@isentinel/roblox-runner";

import { describe, it, vi } from "vitest";

import { projectJob } from "#test/helpers/unit/project-job.ts";
import { createResolvedConfig } from "#test/helpers/unit/resolved-config.ts";
import { envelope, packageJobIndex, scriptResult } from "#test/helpers/unit/spec-open-cloud.ts";
import type { ConfiguredJob } from "../executor/executor-types.ts";
import type { ParallelOption } from "./interface.ts";
import {
	dispatchJobsAsync,
	type OpenCloudSharding,
	type StealingRequest,
} from "./open-cloud-dispatch.ts";
import type { PreparedStealing } from "./open-cloud-work-stealing.ts";

type ExecuteTask = Parameters<typeof dispatchJobsAsync>[0]["executeAsync"];

type ExecuteRequest = Parameters<ExecuteTask>[0];

type ExecuteHandler = (request: ExecuteRequest) => Promise<ScriptResult> | ScriptResult;

type ExecuteStep = () => Promise<ScriptResult> | ScriptResult;

interface ExecuteStub {
	executeAsync: ExecuteTask;
	executeCalls: Array<ExecuteRequest>;
}

interface DispatchShape {
	jobs: [ConfiguredJob, ...Array<ConfiguredJob>];
	parallel?: ParallelOption;
	script?: string;
	stealing?: PreparedStealing | undefined;
	workspace?: true;
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

function shardingOf({ parallel, script, workspace }: DispatchShape): OpenCloudSharding {
	if (script !== undefined) {
		return { bail: false, kind: "work-stealing", parallel };
	}

	if (workspace !== undefined) {
		return { bail: false, kind: "deferrable", parallel };
	}

	return { kind: "static", parallel };
}

async function dispatchAsync(stub: ExecuteStub, shape: DispatchShape) {
	return dispatchJobsAsync({
		executeAsync: stub.executeAsync,
		jobs: shape.jobs,
		prepareStealingAsync: async () => {
			return "stealing" in shape
				? shape.stealing
				: { script: shape.script ?? "", streaming: undefined };
		},
		runSettings: shape.jobs[0].config,
		sharding: shardingOf(shape),
		version: { bootProven: true, versionNumber: 7 },
	});
}

function job(displayName: string): ConfiguredJob {
	return projectJob({
		config: createResolvedConfig(),
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
	});
}

function workspaceJob(packageName: string): ConfiguredJob {
	return { ...job(packageName), pkg: packageName };
}

function successJest(): string {
	return JSON.stringify({ success: true });
}

function packageEntry(packageName: string) {
	return { jestOutput: successJest(), jobIndex: packageJobIndex(packageName), pkg: packageName };
}

function success(jobIndex: number) {
	return { jestOutput: successJest(), jobIndex };
}

function requestedNames(request: ExecuteRequest): Array<string> {
	return Array.from(request.script.matchAll(/"pkg":"([^"]+)"/g), (match) => match[1]!);
}

function scriptedEntries(request: ExecuteRequest): ScriptResult {
	return scriptResult(envelope(requestedNames(request).map(packageEntry)));
}

function deferOnceExecute(deferringHead: string): ExecuteHandler {
	return (request): ScriptResult => {
		const requested = requestedNames(request);
		return requested.length > 1 && requested[0] === deferringHead
			? scriptResult(envelope([packageEntry(deferringHead)], { deferred: true }))
			: scriptedEntries(request);
	};
}

function bailingBucketExecute(bailingHead: string): ExecuteHandler {
	return (request): ScriptResult => {
		return requestedNames(request)[0] === bailingHead
			? scriptResult(envelope([packageEntry(bailingHead)], { bailed: true }))
			: scriptedEntries(request);
	};
}

function stepExecute(steps: Array<ExecuteStep>): ExecuteHandler {
	let callIndex = 0;
	return (): Promise<ScriptResult> | ScriptResult => {
		const step = steps[Math.min(callIndex, steps.length - 1)]!;
		callIndex += 1;
		return step();
	};
}

describe(dispatchJobsAsync, () => {
	it("should pin every task to the run's version and the run config's timeout", async ({
		expect,
	}) => {
		expect.assertions(1);

		const stub = createExecuteStub(() => scriptResult(envelope([success(0)])));
		await dispatchAsync(stub, { jobs: [job("alpha")] });

		expect(stub.executeCalls.map(({ script: _script, ...call }) => call)).toStrictEqual([
			{
				timeout: createResolvedConfig().timeout,
				version: { bootProven: true, versionNumber: 7 },
			},
		]);
	});

	it("should give each static bucket's entries their job index and task game output", async ({
		expect,
	}) => {
		expect.assertions(2);

		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([success(0), success(2)]), "first"),
				() => scriptResult(envelope([success(1)]), "second"),
			]),
		);

		const { rawResults } = await dispatchAsync(stub, {
			jobs: [job("alpha"), job("beta"), job("gamma")],
			parallel: 2,
		});

		expect(
			rawResults.map(({ fallbackGameOutput, jobIndex }) => [jobIndex, fallbackGameOutput]),
		).toStrictEqual([
			[0, "first"],
			[2, "first"],
			[1, "second"],
		]);
		expect(
			stub.executeCalls.map(({ script }) => script.match(/"runnerJobIndex":\d+/g)),
		).toStrictEqual([['"runnerJobIndex":0', '"runnerJobIndex":2'], ['"runnerJobIndex":1']]);
	});

	it("should throw when a static bucket returns no outputs", async ({ expect }) => {
		expect.assertions(1);

		const stub = createExecuteStub(() => ({ durationMs: 0, outputs: [] }));

		await expect(dispatchAsync(stub, { jobs: [job("alpha")] })).rejects.toThrow(
			"No test results in output. Got: []",
		);
	});

	it("should fan one work-stealing script out and collect every package", async ({ expect }) => {
		expect.assertions(2);

		const stub = createExecuteStub(() => scriptResult(envelope([packageEntry("alpha")])));

		const { rawResults } = await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha")],
			script: "stealing-script",
		});

		expect(stub.executeCalls.map((call) => call.script)).toStrictEqual(["stealing-script"]);
		expect(rawResults).toHaveLength(1);
	});

	it("should fall back to a deferrable run when the queue cannot be set up", async ({
		expect,
	}) => {
		expect.assertions(1);

		const stub = createExecuteStub(() => scriptResult(envelope([packageEntry("alpha")])));

		await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha")],
			script: "stealing-script",
			stealing: undefined,
		});

		expect(requestedNames(stub.executeCalls[0]!)).toStrictEqual(["alpha"]);
	});

	it("should ask for the queue with every job and the task deadline", async ({ expect }) => {
		expect.assertions(1);

		const prepareStealingAsync = vi.fn<(request: StealingRequest) => Promise<PreparedStealing>>(
			async () => ({ script: "stealing-script", streaming: undefined }),
		);
		const jobs: [ConfiguredJob, ...Array<ConfiguredJob>] = [
			workspaceJob("alpha"),
			workspaceJob("beta"),
		];

		await dispatchJobsAsync({
			executeAsync: createExecuteStub(() => {
				return scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")]));
			}).executeAsync,
			jobs,
			prepareStealingAsync,
			runSettings: { ...jobs[0].config, timeout: 1234 },
			sharding: { bail: true, kind: "work-stealing", parallel: 2 },
			version: { bootProven: true, versionNumber: 7 },
		});

		expect(prepareStealingAsync).toHaveBeenCalledExactlyOnceWith({
			bail: true,
			inputs: [
				expect.objectContaining<Record<string, unknown>>({ pkg: "alpha" }),
				expect.objectContaining<Record<string, unknown>>({ pkg: "beta" }),
			],
			onPackageResult: undefined,
			taskTimeout: 1234,
		});
	});

	it("should re-send a deferring bucket's leftovers to that bucket alone", async ({ expect }) => {
		expect.assertions(2);

		// Each bucket owns its own deferral chain: the one that filled its
		// envelope re-sends only what it left behind, and its sibling is
		// untouched by the extra round.
		const stub = createExecuteStub(deferOnceExecute("alpha"));

		const results = await dispatchAsync(stub, {
			jobs: [
				workspaceJob("alpha"),
				workspaceJob("beta"),
				workspaceJob("gamma"),
				workspaceJob("delta"),
			],
			parallel: 2,
			workspace: true,
		});

		expect(results.rawResults).toHaveLength(4);
		expect(stub.executeCalls.map(requestedNames)).toStrictEqual([
			["alpha", "gamma"],
			["beta", "delta"],
			["gamma"],
		]);
	});

	it("should keep a sibling bucket's results when one bucket bails", async ({ expect }) => {
		expect.assertions(2);

		// A bail is task-local on this path (there is no signal map to
		// broadcast it), so it stops the bucket that hit it and no other.
		// The sibling still runs its whole share, and the only jobs
		// reported skipped are the tail the bailing bucket never reached.
		const stub = createExecuteStub(bailingBucketExecute("alpha"));

		const results = await dispatchAsync(stub, {
			jobs: [
				workspaceJob("alpha"),
				workspaceJob("beta"),
				workspaceJob("gamma"),
				workspaceJob("delta"),
			],
			parallel: 2,
			workspace: true,
		});

		// gamma alone: it shared alpha's bucket and never ran, while beta
		// and delta came back from the sibling that carried on.
		expect(results.bailed).toBeTrue();
		expect(
			results.rawResults.map(({ jobIndex }) => jobIndex).sort((left, right) => left - right),
		).toStrictEqual([0, 1, 3]);
	});

	it("should re-send the entries a deferring task left behind", async ({ expect }) => {
		expect.assertions(3);

		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
				() => scriptResult(envelope([packageEntry("beta"), packageEntry("gamma")])),
			]),
		);

		const results = await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha"), workspaceJob("beta"), workspaceJob("gamma")],
			workspace: true,
		});

		expect(results.rawResults).toHaveLength(3);
		expect(stub.executeCalls).toHaveLength(2);
		// Only the two that did not come back the first time.
		expect(requestedNames(stub.executeCalls[1]!)).toStrictEqual(["beta", "gamma"]);
	});

	it("should stop after a non-deferred workspace envelope", async ({ expect }) => {
		expect.assertions(2);

		const stub = createExecuteStub(() => {
			return scriptResult(envelope([packageEntry("alpha"), packageEntry("beta")]));
		});

		const result = await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha"), workspaceJob("beta")],
			workspace: true,
		});

		expect(stub.executeCalls).toHaveLength(1);
		expect(result.rawResults).toHaveLength(2);
	});

	it("should stop when a deferred workspace envelope covered every job", async ({ expect }) => {
		expect.assertions(2);

		const stub = createExecuteStub(() => {
			return scriptResult(
				envelope([packageEntry("alpha"), packageEntry("beta")], { deferred: true }),
			);
		});

		const result = await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha"), workspaceJob("beta")],
			workspace: true,
		});

		expect(stub.executeCalls).toHaveLength(1);
		expect(result.rawResults).toHaveLength(2);
	});

	it("should preserve bail evidence across deferred workspace envelopes", async ({ expect }) => {
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
			jobs: [workspaceJob("alpha"), workspaceJob("beta"), workspaceJob("gamma")],
			workspace: true,
		});

		expect(stub.executeCalls).toHaveLength(2);
		expect(result).toMatchObject({
			bailed: true,
			rawResults: [{ jobIndex: 0 }, { jobIndex: 1 }],
		});
	});

	it("should stop re-sending when a task covers nothing new", async ({ expect }) => {
		expect.assertions(2);

		const stub = createExecuteStub(
			stepExecute([
				() => scriptResult(envelope([packageEntry("alpha")], { deferred: true })),
			]),
		);

		const result = await dispatchAsync(stub, {
			jobs: [workspaceJob("alpha"), workspaceJob("beta"), workspaceJob("gamma")],
			workspace: true,
		});

		expect(result.rawResults.map(({ jobIndex }) => jobIndex)).toStrictEqual([0]);
		expect(stub.executeCalls).toHaveLength(2);
	});

	it("should fail a workspace task that returns no output at all", async ({ expect }) => {
		expect.assertions(1);

		const stub = createExecuteStub(() => ({ durationMs: 1, outputs: [] }));

		await expect(
			dispatchAsync(stub, {
				jobs: [workspaceJob("alpha")],
				workspace: true,
			}),
		).rejects.toThrow("No test results in output");
	});
});
