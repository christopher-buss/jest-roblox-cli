import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { fakeTimingCollector } from "#test/mocks/fake-timing-collector.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { makeJestResult } from "#test/mocks/spec-results.ts";
import type { Backend } from "../backends/dispatch-request.ts";
import type { RunResult } from "../results/run-result-types.ts";
import type { LayoutTypes, RunLayout } from "./pipeline.ts";
import { runPipelineAsync } from "./pipeline.ts";

const RESULT: RunResult = { coverageMs: 1, projectResults: [], stagingMs: 2 };

const STAGED = { collectsCoverage: true };

const NO_STAGING = { collectsCoverage: false };

function makeBackend(): Backend & { closeAsync: () => Promise<void> } {
	return fromAny({ closeAsync: vi.fn<() => Promise<void>>(async () => {}), kind: "studio" });
}

function makeLayout(overrides: Partial<RunLayout<LayoutTypes>> = {}) {
	const events: Array<string> = [];
	const backend = makeBackend();
	const typecheckResult = makeJestResult();
	const layout: RunLayout<LayoutTypes> = {
		buildResult: vi.fn<RunLayout<LayoutTypes>["buildResult"]>(() => RESULT),
		dispatchAsync: vi.fn<RunLayout<LayoutTypes>["dispatchAsync"]>(async () => {
			events.push("dispatch");
			return "dispatched";
		}),
		noRuntime: () => ({ dispatched: "no dispatch", staged: NO_STAGING }),
		openBackend: vi.fn<RunLayout<LayoutTypes>["openBackend"]>((): Backend => {
			events.push("open");
			return backend;
		}),
		resolveUnitsAsync: async () => {
			return {
				header: {
					color: false,
					formatters: undefined,
					rootDir: "/r",
					silent: false,
					verbose: false,
				},
			};
		},
		selectTests: () => ({ runtimeJobCount: 1, typeTestEntries: [] }),
		stageAsync: vi.fn<RunLayout<LayoutTypes>["stageAsync"]>(async () => {
			events.push("stage");
			return STAGED;
		}),
		typecheckAsync: vi.fn<RunLayout<LayoutTypes>["typecheckAsync"]>(async () => {
			return { outcome: { elapsedMs: 5, result: typecheckResult } };
		}),
		...overrides,
	};
	return { backend, events, layout, typecheckResult };
}

describe(runPipelineAsync, () => {
	it("should return the refusal of unit resolution", async () => {
		expect.assertions(2);

		const refused = fromAny<RunResult, unknown>({ validationExitCode: 2 });
		const { layout } = makeLayout({ resolveUnitsAsync: async () => ({ refused }) });

		await expect(
			runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() }),
		).resolves.toBe(refused);
		expect(layout.openBackend).not.toHaveBeenCalled();
	});

	it("should return the refusal of test selection", async () => {
		expect.assertions(1);

		const refused = fromAny<RunResult, unknown>({ validationExitCode: 2 });
		const { layout } = makeLayout({ selectTests: () => ({ refused }) });

		await expect(
			runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() }),
		).resolves.toBe(refused);
	});

	it("should reject TypeScript Type Tests under the standalone binary before staging", async () => {
		expect.assertions(2);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { layout } = makeLayout({
			selectTests: () => {
				return {
					runtimeJobCount: 1,
					typeTestEntries: [{ cwd: "/r", files: ["a.spec-d.ts"] }],
				};
			},
		});

		await expect(
			runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() }),
		).rejects.toThrow("--typecheck is not available in the standalone binary");
		expect(layout.stageAsync).not.toHaveBeenCalled();
	});

	it("should stop an empty run before any backend or type pass", async () => {
		expect.assertions(3);

		const { layout } = makeLayout({
			selectTests: () => {
				return {
					emptiness: { validationExitCode: 2 },
					runtimeJobCount: 0,
					typeTestEntries: [],
				};
			},
		});

		const result = await runPipelineAsync(layout, {
			progress: NOOP_PROGRESS,
			timing: fakeTimingCollector(),
		});

		expect(result).toStrictEqual({
			coverageMs: 0,
			projectResults: [],
			stagingMs: 0,
			validationExitCode: 2,
		});
		expect(layout.openBackend).not.toHaveBeenCalled();
		expect(layout.typecheckAsync).not.toHaveBeenCalled();
	});

	it("should run only the type pass when no runtime job was selected", async () => {
		expect.assertions(4);

		const timing = fakeTimingCollector();
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { layout, typecheckResult } = makeLayout({
			selectTests: () => ({ runtimeJobCount: 0, typeTestEntries: [] }),
		});

		await runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing });

		expect(layout.openBackend).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		expect(timing.record).toHaveBeenCalledExactlyOnceWith("runTypecheck", 5);
		expect(layout.buildResult).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				dispatched: "no dispatch",
				staged: NO_STAGING,
				typecheck: { outcome: { elapsedMs: 5, result: typecheckResult } },
			}),
		);
	});

	it("should open the backend, stage, announce, dispatch and close in order", async () => {
		expect.assertions(5);

		const timing = fakeTimingCollector();
		const { events, layout } = makeLayout();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			events.push("header");
			return true;
		});

		const result = await runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing });

		expect(result).toBe(RESULT);
		expect(events).toStrictEqual(["open", "stage", "header", "dispatch"]);
		expect(stdout).toHaveBeenCalledWith(expect.stringContaining(" RUN "));
		expect(timing.profileAsync).toHaveBeenCalledWith("resolveBackend", expect.any(Function));
		expect(layout.buildResult).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ dispatched: "dispatched", staged: STAGED }),
		);
	});

	it.for<[boolean]>([[true], [false]])(
		"should announce coverage in the header exactly when staging collects it (%s)",
		async ([collectsCoverage]) => {
			expect.assertions(1);

			const { layout } = makeLayout({ stageAsync: async () => ({ collectsCoverage }) });
			const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

			await runPipelineAsync(layout, {
				progress: NOOP_PROGRESS,
				timing: fakeTimingCollector(),
			});

			const header = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");

			expect(header.includes("Coverage enabled")).toBe(collectsCoverage);
		},
	);

	it("should close the backend after the dispatch", async () => {
		expect.assertions(1);

		const { backend, layout } = makeLayout();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);

		await runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() });

		expect(backend.closeAsync).toHaveBeenCalledOnce();
	});

	it("should close the backend when staging fails", async () => {
		expect.assertions(2);

		const error = new Error("rojo failed");
		const { backend, layout } = makeLayout({
			stageAsync: async () => {
				throw error;
			},
		});

		await expect(
			runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() }),
		).rejects.toBe(error);
		expect(backend.closeAsync).toHaveBeenCalledOnce();
	});

	it("should tolerate a backend without a close hook", async () => {
		expect.assertions(1);

		const { layout } = makeLayout({
			openBackend: () => fromAny<Backend, unknown>({ kind: "studio" }),
		});

		await expect(
			runPipelineAsync(layout, { progress: NOOP_PROGRESS, timing: fakeTimingCollector() }),
		).resolves.toBe(RESULT);
	});
});
