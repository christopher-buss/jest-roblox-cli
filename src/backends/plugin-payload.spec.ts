import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { DecodedEnvelope } from "./envelope.ts";
import type { ProjectJob } from "./interface.ts";
import { buildRunPayload, pairPluginEntries } from "./plugin-payload.ts";

function job(displayName: string, overrides: Partial<ProjectJob> = {}): ProjectJob {
	return {
		config: { ...createResolvedConfig(), rootDir: "/repo" },
		displayName,
		testFiles: [`${displayName}/test.spec.ts`],
		...overrides,
	};
}

function envelope(entryCount: number, flags: Partial<DecodedEnvelope> = {}): DecodedEnvelope {
	return {
		bailed: false,
		deferred: false,
		entries: Array.from({ length: entryCount }, (_, index) => fromAny({ index })),
		gameOutputScope: undefined,
		...flags,
	};
}

const PAIRING = { backendName: "Studio backend", gameOutput: "out.log", jobCount: 2 };

describe(buildRunPayload, () => {
	it("should send configs with their runtime stub mounts", () => {
		expect.assertions(2);

		const payload = buildRunPayload({
			jobs: [
				job("alpha", { runtimeInjectionPaths: ["ReplicatedStorage/alpha"] }),
				job("beta"),
			],
			runBudgetMs: 1000,
		});

		expect(payload).toMatchObject({
			runtimeStubMounts: [["ReplicatedStorage/alpha"], []],
		});
		expect(payload).not.toHaveProperty("vmParallel");
	});

	it("should send the VM count and run budget for a parallel config run", () => {
		expect.assertions(1);

		const payload = buildRunPayload({
			jobs: [job("alpha"), job("beta"), job("gamma")],
			runBudgetMs: 1000,
			vmParallel: "auto",
		});

		expect(payload).toMatchObject({ runBudgetMs: 1000, vmParallel: 3 });
	});

	it("should send workspace entries with an unbounded result budget", () => {
		expect.assertions(1);

		const payload = buildRunPayload({
			bail: true,
			jobs: [job("alpha", { pkg: "@scope/a" }), job("beta", { pkg: "@scope/b" })],
			runBudgetMs: 1000,
			vmParallel: "auto",
		});

		expect(payload).toMatchObject({
			workspace: {
				bail: true,
				entries: [
					{ pkg: "@scope/a", project: "alpha" },
					{ pkg: "@scope/b", project: "beta" },
				],
				resultBudgetBytes: Number.MAX_SAFE_INTEGER,
			},
		});
	});

	it("should split VMs by the largest consecutive run of one package", () => {
		expect.assertions(1);

		const payload = buildRunPayload({
			jobs: [
				job("a1", { pkg: "a" }),
				job("b1", { pkg: "b" }),
				job("b2", { pkg: "b" }),
				job("a2", { pkg: "a" }),
			],
			runBudgetMs: 1000,
			vmParallel: "auto",
		});

		expect(payload).toMatchObject({ workspace: { runBudgetMs: 1000, vmParallel: 2 } });
	});

	it("should fail fast when a workspace job is missing its package name", () => {
		expect.assertions(1);

		expect(() => {
			return buildRunPayload({
				jobs: [job("alpha", { pkg: "a" }), job("beta")],
				runBudgetMs: 1000,
			});
		}).toThrow(
			'studio-cli: workspace entry for project "beta" is missing its package name (pkg)',
		);
	});
});

describe(pairPluginEntries, () => {
	it("should pair every entry with the fallback game output", () => {
		expect.assertions(1);

		const decoded = envelope(2, { gameOutputScope: "batch" });
		const result = pairPluginEntries(decoded, PAIRING);

		expect(result).toStrictEqual({
			rawResults: decoded.entries.map((entry) => {
				return { entry, fallbackGameOutput: "out.log", gameOutputScope: "batch" };
			}),
		});
	});

	it("should name the jobs a bail never started", () => {
		expect.assertions(1);

		const result = pairPluginEntries(envelope(1, { bailed: true }), {
			...PAIRING,
			jobCount: 3,
		});

		expect(result.bailedJobIndices).toStrictEqual([1, 2]);
	});

	it("should name a deferred stop rather than an entry count mismatch", () => {
		expect.assertions(1);

		expect(() => pairPluginEntries(envelope(1, { deferred: true }), PAIRING)).toThrow(
			"Studio backend deferred 1 of 2 jobs: the runner's result budget filled before they ran",
		);
	});

	it("should reject an entry count that does not match the request", () => {
		expect.assertions(1);

		expect(() => pairPluginEntries(envelope(3), PAIRING)).toThrow(
			"Studio backend returned 3 entries but request had 2 jobs",
		);
	});

	it("should reject fewer entries than the request had jobs", () => {
		expect.assertions(1);

		expect(() => pairPluginEntries(envelope(1), PAIRING)).toThrow(
			"Studio backend returned 1 entries but request had 2 jobs",
		);
	});
});
