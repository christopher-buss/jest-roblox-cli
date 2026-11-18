import { fromAny } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, it, type TestContext, vi } from "vitest";

import type { MappedCoverageResult } from "../coverage-report/mapper-types.ts";
import type { CoverageReportUnit, OutputSettings } from "../results/run-result-types.ts";
import { type CoveragePipeline, printFinalStatus, processCoverage } from "./coverage-output.ts";

const UNIVERSE = fromAny<MappedCoverageResult, unknown>({ files: {} });

type ThresholdFailure = ReturnType<CoveragePipeline["checkThresholds"]>["failures"][number];

function makeSettings(
	overrides: Partial<OutputSettings> = {},
): Pick<OutputSettings, "formatters" | "silent" | "verbose"> {
	return { formatters: ["default"], silent: false, verbose: false, ...overrides };
}

function makePipeline(overrides: Partial<CoveragePipeline> = {}) {
	return {
		checkThresholds: vi.fn<CoveragePipeline["checkThresholds"]>(() => {
			return { failures: [], passed: true };
		}),
		generateReports: vi.fn<CoveragePipeline["generateReports"]>(),
		...overrides,
	};
}

function captureOutput(onTestFinished: TestContext["onTestFinished"]) {
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	onTestFinished(() => {
		stdout.mockRestore();
		stderr.mockRestore();
	});
	return {
		stderr: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
		stdout: () => stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
	};
}

function makeUnit(overrides: Partial<CoverageReportUnit> = {}): CoverageReportUnit {
	return {
		coverageDirectory: "/repo/coverage",
		reporters: ["text"],
		universe: UNIVERSE,
		...overrides,
	};
}

function failingPipeline(failure: ThresholdFailure) {
	return makePipeline({
		checkThresholds: vi.fn<CoveragePipeline["checkThresholds"]>(() => {
			return { failures: [failure], passed: false };
		}),
	});
}

describe(processCoverage, () => {
	it("should skip everything when the run collected no coverage", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const output = captureOutput(onTestFinished);

		expect(
			processCoverage({
				coverage: undefined,
				pipeline: makePipeline(),
				settings: makeSettings(),
			}),
		).toBeTrue();
		expect(output.stdout()).toBe("");
	});

	it("should write the notice and pass when nothing was mappable", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(3);

		const output = captureOutput(onTestFinished);
		const pipeline = makePipeline();

		expect(
			processCoverage({
				coverage: { notice: "Warning: nothing", units: [] },
				pipeline,
				settings: makeSettings(),
			}),
		).toBeTrue();
		expect(output.stderr()).toBe("Warning: nothing\n");
		expect(pipeline.generateReports).not.toHaveBeenCalled();
	});

	it("should keep the notice off stderr when silent", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		const output = captureOutput(onTestFinished);

		processCoverage({
			coverage: { notice: "Warning: nothing", units: [] },
			pipeline: makePipeline(),
			settings: makeSettings({ silent: true }),
		});

		expect(output.stderr()).toBe("");
	});

	it("should report an unlabelled unit and pass without a threshold", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(5);

		const output = captureOutput(onTestFinished);
		const pipeline = makePipeline();

		expect(
			processCoverage({
				coverage: { units: [makeUnit()] },
				pipeline,
				settings: makeSettings(),
			}),
		).toBeTrue();
		expect(output.stdout()).toContain("Coverage report from");
		expect(output.stdout()).not.toContain("undefined");
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				agentMode: false,
				coverageDirectory: "/repo/coverage",
				mapped: UNIVERSE,
			}),
		);
		expect(pipeline.checkThresholds).not.toHaveBeenCalled();
	});

	it("should fail and name each unmet metric of an unlabelled unit", ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const output = captureOutput(onTestFinished);

		expect(
			processCoverage({
				coverage: { units: [makeUnit({ coverageThreshold: { lines: 80 } })] },
				pipeline: failingPipeline({ actual: 50, metric: "lines", threshold: 80 }),
				settings: makeSettings(),
			}),
		).toBeFalse();
		expect(output.stderr()).toBe("Coverage threshold not met for lines: 50.00% < 80%\n");
	});

	it("should pass when the threshold is met", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		captureOutput(onTestFinished);

		expect(
			processCoverage({
				coverage: { units: [makeUnit({ coverageThreshold: { lines: 80 } })] },
				pipeline: makePipeline(),
				settings: makeSettings(),
			}),
		).toBeTrue();
	});

	it("should label and gate every package on its own threshold", ({ expect, onTestFinished }) => {
		expect.assertions(4);

		const output = captureOutput(onTestFinished);
		const pipeline = failingPipeline({ actual: 10, metric: "branches", threshold: 90 });

		expect(
			processCoverage({
				coverage: {
					units: [
						makeUnit({ coverageThreshold: { branches: 90 }, label: "alpha" }),
						makeUnit({ label: "beta" }),
					],
				},
				pipeline,
				settings: makeSettings({ formatters: ["agent"] }),
			}),
		).toBeFalse();
		expect(output.stdout()).toContain("\nalpha\n");
		expect(output.stderr()).toBe(
			"Coverage threshold not met for alpha branches: 10.00% < 90%\n",
		);
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ agentMode: true }),
		);
	});

	it("should print neither header nor labels when silent", ({ expect, onTestFinished }) => {
		expect.assertions(1);

		const output = captureOutput(onTestFinished);

		processCoverage({
			coverage: { units: [makeUnit({ label: "alpha" })] },
			pipeline: makePipeline(),
			settings: makeSettings({ silent: true }),
		});

		expect(output.stdout()).toBe("");
	});
});

describe(printFinalStatus, () => {
	it.for([
		{ badge: " PASS ", passed: true },
		{ badge: " FAIL ", passed: false },
	])(
		"should write the badge for passed=$passed",
		({ badge, passed }, { expect, onTestFinished }) => {
			expect.assertions(1);

			const output = captureOutput(onTestFinished);
			printFinalStatus(passed);

			expect(output.stdout()).toContain(badge);
		},
	);
});
