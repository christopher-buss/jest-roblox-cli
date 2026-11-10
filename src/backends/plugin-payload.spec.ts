import { describe, expect, it } from "vitest";

import { projectJob } from "#test/mocks/project-job.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { DecodedEnvelope } from "./envelope.ts";
import type { ProjectJob } from "./interface.ts";
import { buildRunPayload, readPluginEntries, type RunPayloadRequest } from "./plugin-payload.ts";

function job(displayName: string, overrides: Partial<ProjectJob> = {}): ProjectJob {
	return projectJob({
		config: { ...createResolvedConfig(), rootDir: "/repo" },
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
		...overrides,
	});
}

function envelope(entryCount: number, flags: Partial<DecodedEnvelope> = {}): DecodedEnvelope {
	return {
		bailed: false,
		deferred: false,
		entries: Array.from({ length: entryCount }, (_, index) => {
			return { jestOutput: `out-${index.toString()}`, jobIndex: entryCount - 1 - index };
		}),
		gameOutputScope: undefined,
		...flags,
	};
}

function payloadRequest(
	request: Partial<RunPayloadRequest> & Pick<RunPayloadRequest, "jobs" | "runBudgetMs">,
): RunPayloadRequest {
	return {
		bail: false,
		runtimeStubs: true,
		vmParallel: undefined,
		workspace: request.jobs.some((entry) => entry.pkg !== undefined),
		...request,
	};
}

const PAIRING = { backendName: "Studio backend", gameOutput: "out.log", jobCount: 2 };

describe(buildRunPayload, () => {
	it("should send configs with their runtime stub mounts", () => {
		expect.assertions(2);

		const payload = buildRunPayload(
			payloadRequest({
				jobs: [
					job("alpha", { runtimeInjectionPaths: ["ReplicatedStorage/alpha"] }),
					job("beta"),
				],
				runBudgetMs: 1000,
			}),
		);

		expect(payload).toMatchObject({
			configs: [
				{
					config: { runnerJobIndex: 0 },
					runtimeStubMounts: ["ReplicatedStorage/alpha"],
				},
				{ config: { runnerJobIndex: 1 }, runtimeStubMounts: [] },
			],
		});
		expect(payload).not.toHaveProperty("vmParallel");
	});

	it("should send no runtime stub mounts when the place has the stubs built in", () => {
		expect.assertions(1);

		const payload = buildRunPayload(
			payloadRequest({
				jobs: [job("alpha", { runtimeInjectionPaths: ["ReplicatedStorage/alpha"] })],
				runBudgetMs: 1000,
				runtimeStubs: false,
			}),
		);

		expect(payload).toMatchObject({ configs: [{ runtimeStubMounts: [] }] });
	});

	it("should send the VM count and run budget for a parallel config run", () => {
		expect.assertions(1);

		const payload = buildRunPayload(
			payloadRequest({
				jobs: [job("alpha"), job("beta"), job("gamma")],
				runBudgetMs: 1000,
				vmParallel: "auto",
			}),
		);

		expect(payload).toMatchObject({ runBudgetMs: 1000, vmParallel: 3 });
	});

	it.for([
		["auto", 3, 3],
		["auto", 10, 4],
		["auto", 1, undefined],
		[2, 5, 2],
		[2.9, 5, 2],
		[8, 3, 3],
		[8, 10, 4],
		[1, 5, undefined],
		[0, 5, undefined],
	] as const)(
		"should start %j VMs over %i configs as %j",
		([vmParallel, configCount, expected]) => {
			expect.assertions(1);

			const payload = buildRunPayload(
				payloadRequest({
					jobs: [
						job("p0"),
						...Array.from({ length: configCount - 1 }, (_unused, index) => {
							return job(`p${index + 1}`);
						}),
					],
					runBudgetMs: 1000,
					vmParallel,
				}),
			);

			expect(Reflect.get(payload, "vmParallel")).toBe(expected);
		},
	);

	it("should send workspace entries with an unbounded result budget", () => {
		expect.assertions(1);

		const payload = buildRunPayload(
			payloadRequest({
				bail: true,
				jobs: [job("alpha", { pkg: "@scope/a" }), job("beta", { pkg: "@scope/b" })],
				runBudgetMs: 1000,
				vmParallel: "auto",
			}),
		);

		expect(payload).toMatchObject({
			workspace: {
				bail: true,
				entries: [
					{ config: { runnerJobIndex: 0 }, pkg: "@scope/a", project: "alpha" },
					{ config: { runnerJobIndex: 1 }, pkg: "@scope/b", project: "beta" },
				],
				resultBudgetBytes: Number.MAX_SAFE_INTEGER,
			},
		});
	});

	it("should cap the VM count by the entry count and leave the per-package split to the plugin", () => {
		expect.assertions(1);

		const payload = buildRunPayload(
			payloadRequest({
				jobs: [
					job("a1", { pkg: "a" }),
					job("b1", { pkg: "b" }),
					job("b2", { pkg: "b" }),
					job("a2", { pkg: "a" }),
				],
				runBudgetMs: 1000,
				vmParallel: "auto",
			}),
		);

		expect(payload).toMatchObject({ workspace: { runBudgetMs: 1000, vmParallel: 4 } });
	});

	it("should fail fast when a workspace job is missing its package name", () => {
		expect.assertions(1);

		expect(() => {
			return buildRunPayload(
				payloadRequest({
					jobs: [job("alpha", { pkg: "a" }), job("beta")],
					runBudgetMs: 1000,
				}),
			);
		}).toThrow('Workspace entry for project "beta" is missing its package name (pkg)');
	});
});

describe(readPluginEntries, () => {
	it("should give every entry the job it names and the fallback game output", () => {
		expect.assertions(1);

		const result = readPluginEntries(envelope(2, { gameOutputScope: "batch" }), PAIRING);

		expect(result).toStrictEqual({
			bailed: false,
			rawResults: [
				{
					entry: { jestOutput: "out-0" },
					fallbackGameOutput: "out.log",
					gameOutputScope: "batch",
					jobIndex: 1,
				},
				{
					entry: { jestOutput: "out-1" },
					fallbackGameOutput: "out.log",
					gameOutputScope: "batch",
					jobIndex: 0,
				},
			],
		});
	});

	it("should report a bail", () => {
		expect.assertions(1);

		const result = readPluginEntries(envelope(1, { bailed: true }), {
			...PAIRING,
			jobCount: 3,
		});

		expect(result.bailed).toBeTrue();
	});

	it("should name a deferred stop", () => {
		expect.assertions(1);

		expect(() => readPluginEntries(envelope(1, { deferred: true }), PAIRING)).toThrow(
			"Studio backend deferred 1 of 2 jobs: the runner's result budget filled before they ran",
		);
	});
});
