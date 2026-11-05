import { fromAny, fromPartial } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { RawCoverageData } from "../coverage-pipeline/coverage-types.ts";
import type { MappedCoverageResult } from "../coverage-pipeline/mapper-types.ts";
import type { WorkspacePackageCoverageGate } from "../run/run-types.ts";
import {
	type CoveragePipeline,
	extractCoverageDisplayFilter,
	extractCoveragePackages,
	printFinalStatus,
	processCoverage,
} from "./coverage-report.ts";

const UNIVERSE = fromAny<MappedCoverageResult, unknown>({ files: {} });
const COVERAGE_DATA = fromAny<RawCoverageData, unknown>({});

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...createResolvedConfig(),
		collectCoverage: true,
		formatters: ["default"],
		rootDir: "/repo",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function makePipeline(overrides: Partial<CoveragePipeline> = {}) {
	return {
		checkThresholds: vi.fn<CoveragePipeline["checkThresholds"]>(() => {
			return { failures: [], passed: true };
		}),
		generateReports: vi.fn<CoveragePipeline["generateReports"]>(),
		loadCoverageManifest: vi.fn<CoveragePipeline["loadCoverageManifest"]>(() => fromAny({})),
		mapCoverageToTypeScript: vi.fn<CoveragePipeline["mapCoverageToTypeScript"]>(() => UNIVERSE),
		...overrides,
	};
}

function captureOutput() {
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

function makeGate(overrides: Partial<WorkspacePackageCoverageGate> = {}) {
	return fromPartial<WorkspacePackageCoverageGate>({
		coverageDirectory: "/repo/pkg/coverage",
		coverageReporters: ["text"],
		pkg: "pkg",
		universe: UNIVERSE,
		...overrides,
	});
}

describe(processCoverage, () => {
	it("should skip everything when coverage is off", () => {
		expect.assertions(2);

		const output = captureOutput();

		expect(
			processCoverage({
				config: makeConfig({ collectCoverage: false }),
				coverageData: COVERAGE_DATA,
				pipeline: makePipeline(),
			}),
		).toBeTrue();
		expect(output.stdout()).toBe("");
	});

	it.for([
		{ coverageData: undefined, warning: "coverage data was empty" },
		{ coverageData: COVERAGE_DATA, warning: "Coverage manifest not found" },
	])("should warn and pass when nothing is mappable ($warning)", ({ coverageData, warning }) => {
		expect.assertions(3);

		const output = captureOutput();
		const pipeline = makePipeline({
			loadCoverageManifest: vi.fn<CoveragePipeline["loadCoverageManifest"]>(),
		});

		expect(
			processCoverage({
				config: makeConfig(),
				coverageData,
				pipeline,
			}),
		).toBeTrue();
		expect(output.stderr()).toContain(warning);
		expect(pipeline.generateReports).not.toHaveBeenCalled();
	});

	it.for([COVERAGE_DATA, undefined])(
		"should keep silent warnings off stderr (%o)",
		(coverageData) => {
			expect.assertions(1);

			const output = captureOutput();

			processCoverage({
				config: makeConfig({ silent: true }),
				coverageData,
				pipeline: makePipeline({
					loadCoverageManifest: vi.fn<CoveragePipeline["loadCoverageManifest"]>(),
				}),
			});

			expect(output.stderr()).toBe("");
		},
	);

	it("should report the single unit and pass without a threshold", () => {
		expect.assertions(4);

		const output = captureOutput();
		const pipeline = makePipeline();

		expect(
			processCoverage({
				config: makeConfig({ coverageDirectory: "cov" }),
				coverageData: COVERAGE_DATA,
				pipeline,
			}),
		).toBeTrue();
		expect(output.stdout()).toContain("Coverage report from");
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({
				agentMode: false,
				coverageDirectory: path.resolve("/repo", "cov"),
				mapped: UNIVERSE,
			}),
		);
		expect(pipeline.checkThresholds).not.toHaveBeenCalled();
	});

	it("should fail and name each unmet metric when the threshold fails", () => {
		expect.assertions(2);

		const output = captureOutput();
		const pipeline = makePipeline({
			checkThresholds: vi.fn<CoveragePipeline["checkThresholds"]>(() => {
				return {
					failures: [{ actual: 50, metric: "lines", threshold: 80 }],
					passed: false,
				};
			}),
		});

		expect(
			processCoverage({
				config: makeConfig({ coverageThreshold: { lines: 80 } }),
				coverageData: COVERAGE_DATA,
				pipeline,
			}),
		).toBeFalse();
		expect(output.stderr()).toBe("Coverage threshold not met for lines: 50.00% < 80%\n");
	});

	it("should pass when the threshold is met", () => {
		expect.assertions(1);

		captureOutput();

		expect(
			processCoverage({
				config: makeConfig({ coverageThreshold: { lines: 80 } }),
				coverageData: COVERAGE_DATA,
				pipeline: makePipeline(),
			}),
		).toBeTrue();
	});

	it("should pass with no output when the workspace has no package gates", () => {
		expect.assertions(2);

		const output = captureOutput();

		expect(
			processCoverage({
				config: makeConfig(),
				coverageData: undefined,
				packageGates: [],
				pipeline: makePipeline(),
			}),
		).toBeTrue();
		expect(output.stdout()).toBe("");
	});

	it("should label and gate every workspace package on its own threshold", () => {
		expect.assertions(4);

		const output = captureOutput();
		const pipeline = makePipeline({
			checkThresholds: vi.fn<CoveragePipeline["checkThresholds"]>(() => {
				return {
					failures: [{ actual: 10, metric: "branches", threshold: 90 }],
					passed: false,
				};
			}),
		});

		expect(
			processCoverage({
				config: makeConfig({ formatters: ["agent"] }),
				coverageData: undefined,
				packageGates: [
					makeGate({ coverageThreshold: { branches: 90 }, pkg: "alpha" }),
					makeGate({ pkg: "beta" }),
				],
				pipeline,
			}),
		).toBeFalse();
		expect(output.stdout()).toContain("\nalpha\n");
		expect(output.stderr()).toBe(
			"Coverage threshold not met for alpha branches: 10.00% < 90%\n",
		);
		expect(pipeline.generateReports).toHaveBeenCalledWith(
			expect.objectContaining({ agentMode: true, collectCoverageFrom: undefined }),
		);
	});

	it("should print neither header nor labels when silent", () => {
		expect.assertions(1);

		const output = captureOutput();

		processCoverage({
			config: makeConfig({ silent: true }),
			coverageData: undefined,
			packageGates: [makeGate()],
			pipeline: makePipeline(),
		});

		expect(output.stdout()).toBe("");
	});
});

describe(printFinalStatus, () => {
	it.for([
		{ badge: " PASS ", passed: true },
		{ badge: " FAIL ", passed: false },
	])("should print the $badge badge", ({ badge, passed }) => {
		expect.assertions(1);

		const output = captureOutput();
		printFinalStatus(passed);

		expect(output.stdout()).toContain(badge);
	});
});

describe(extractCoveragePackages, () => {
	it("should return the gates of a workspace run only", () => {
		expect.assertions(2);

		const gates = [makeGate()];

		expect(
			extractCoveragePackages(fromPartial({ coveragePackages: gates, mode: "workspace" })),
		).toBe(gates);
		expect(extractCoveragePackages(fromPartial({ mode: "multi" }))).toBeUndefined();
	});
});

describe(extractCoverageDisplayFilter, () => {
	it("should return the display filter of a multi run only", () => {
		expect.assertions(2);

		function filter(): boolean {
			return true;
		}

		expect(
			extractCoverageDisplayFilter(
				fromPartial({ coverageDisplayFilter: filter, mode: "multi" }),
			),
		).toBe(filter);
		expect(extractCoverageDisplayFilter(fromPartial({ mode: "workspace" }))).toBeUndefined();
	});
});
