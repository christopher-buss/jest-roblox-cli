import { randomUUID } from "node:crypto";
import * as path from "node:path";
import process from "node:process";
import type { Reporter, TestModule, TestRunEndReason } from "vitest/node";

import type { FileSystem } from "../../src/utils/file-system.ts";

export const NOTE_PREFIX = "open-cloud-quota:";

/** A run with a quota skip never exits 0, so Nx never caches the skip. */
export class QuotaSkipReporter implements Reporter {
	private readonly fileSystem: FileSystem;

	constructor(fileSystem: FileSystem) {
		this.fileSystem = fileSystem;
	}

	public onTestRunEnd(
		testModules: ReadonlyArray<TestModule>,
		_unhandledErrors: ReadonlyArray<unknown>,
		reason: TestRunEndReason,
	): void {
		const skippedTests = countQuotaSkips(testModules);
		if (skippedTests === 0) {
			return;
		}

		process.stderr.write(
			`\n${skippedTests} live test(s) skipped: Roblox refused the task create on its quota. Failing the run so the skip is not cached.\n`,
		);
		if (reason === "passed") {
			this.writeReport();
		}

		process.exitCode = 1;
	}

	private writeReport(): void {
		const directory = process.env["OPEN_CLOUD_QUOTA_REPORT_DIR"];
		const project = process.env["NX_TASK_TARGET_PROJECT"];
		const target = process.env["NX_TASK_TARGET_TARGET"];
		if (directory === undefined || project === undefined || target === undefined) {
			return;
		}

		this.fileSystem.mkdirSync(directory, { recursive: true });
		this.fileSystem.writeFileSync(path.join(directory, randomUUID()), `${project}:${target}\n`);
	}
}

function countQuotaSkips(testModules: ReadonlyArray<TestModule>): number {
	let count = 0;
	for (const module of testModules) {
		for (const test of module.children.allTests()) {
			const result = test.result();
			if (result.state === "skipped" && result.note?.startsWith(NOTE_PREFIX) === true) {
				count += 1;
			}
		}
	}

	return count;
}
