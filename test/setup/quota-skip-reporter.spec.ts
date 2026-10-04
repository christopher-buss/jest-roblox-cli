import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { TestModule } from "vitest/node";

import { createMemoryFileSystem } from "../mocks/memory-file-system.ts";
import { NOTE_PREFIX, QuotaSkipReporter } from "./quota-skip-reporter.ts";

const REPORT_DIRECTORY = "/reports";

interface FakeResult {
	note?: string | undefined;
	state: "passed" | "skipped";
}

function makeModules(results: Array<FakeResult>): ReadonlyArray<TestModule> {
	const tests = results.map((result) => ({ result: () => result }));
	return [fromPartial<TestModule>({ children: { allTests: () => tests.values() } })];
}

function quotaSkip(): FakeResult {
	return { note: `${NOTE_PREFIX} Roblox refused the task create`, state: "skipped" };
}

function setupReporter() {
	const previous = process.exitCode;
	onTestFinished(() => {
		process.exitCode = previous;
	});
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const { fileSystem, volume } = createMemoryFileSystem();

	return {
		reportContents: () => Object.values(volume.toJSON(REPORT_DIRECTORY)),
		reporter: new QuotaSkipReporter(fileSystem),
	};
}

describe(QuotaSkipReporter, () => {
	it("should leave a run without quota skips alone", () => {
		expect.assertions(1);

		const { reporter } = setupReporter();
		process.exitCode = 0;

		reporter.onTestRunEnd(
			makeModules([
				{ state: "passed" },
				{ note: undefined, state: "skipped" },
				{ note: "other", state: "skipped" },
			]),
			[],
			"passed",
		);

		expect(process.exitCode).toBe(0);
	});

	it("should fail an otherwise green run and report its Nx task", () => {
		expect.assertions(2);

		const { reportContents, reporter } = setupReporter();
		vi.stubEnv("OPEN_CLOUD_QUOTA_REPORT_DIR", REPORT_DIRECTORY);
		vi.stubEnv("NX_TASK_TARGET_PROJECT", "jest-roblox-cli");
		vi.stubEnv("NX_TASK_TARGET_TARGET", "e2e-live");

		reporter.onTestRunEnd(makeModules([{ state: "passed" }, quotaSkip()]), [], "passed");

		expect(process.exitCode).toBe(1);
		expect(reportContents()).toStrictEqual(["jest-roblox-cli:e2e-live\n"]);
	});

	it("should report nothing outside an Nx task", () => {
		expect.assertions(2);

		const { reportContents, reporter } = setupReporter();
		vi.stubEnv("OPEN_CLOUD_QUOTA_REPORT_DIR", REPORT_DIRECTORY);
		vi.stubEnv("NX_TASK_TARGET_PROJECT", undefined);

		reporter.onTestRunEnd(makeModules([quotaSkip()]), [], "passed");

		expect(process.exitCode).toBe(1);
		expect(reportContents()).toBeEmpty();
	});

	it("should report nothing for a task without a target", () => {
		expect.assertions(2);

		const { reportContents, reporter } = setupReporter();
		vi.stubEnv("OPEN_CLOUD_QUOTA_REPORT_DIR", REPORT_DIRECTORY);
		vi.stubEnv("NX_TASK_TARGET_PROJECT", "jest-roblox-cli");
		vi.stubEnv("NX_TASK_TARGET_TARGET", undefined);

		reporter.onTestRunEnd(makeModules([quotaSkip()]), [], "passed");

		expect(process.exitCode).toBe(1);
		expect(reportContents()).toBeEmpty();
	});

	it("should write no report when the run also failed for another reason", () => {
		expect.assertions(1);

		const { reportContents, reporter } = setupReporter();
		vi.stubEnv("OPEN_CLOUD_QUOTA_REPORT_DIR", REPORT_DIRECTORY);
		vi.stubEnv("NX_TASK_TARGET_PROJECT", "jest-roblox-cli");

		reporter.onTestRunEnd(makeModules([quotaSkip()]), [], "failed");

		expect(reportContents()).toBeEmpty();
	});

	it("should fail the run without a report directory", () => {
		expect.assertions(1);

		const { reporter } = setupReporter();
		vi.stubEnv("OPEN_CLOUD_QUOTA_REPORT_DIR", undefined);

		reporter.onTestRunEnd(makeModules([quotaSkip()]), [], "passed");

		expect(process.exitCode).toBe(1);
	});
});
