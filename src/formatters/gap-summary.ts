import { listBlocked } from "../results/gaps.ts";
import type { SourceMapper } from "../source-mapper/index.ts";
import type { JestResult, TestCaseResult, TestFileResult } from "../types/jest-result.ts";
import { resolveDisplayPath } from "./shared.ts";

const COLLATOR = new Intl.Collator();

/**
 * The end-of-run list of Blocked tests, each with the gaps that reached it.
 * Undefined when no test is Blocked.
 *
 * @param result - The run's result, with gaps on its tests and files.
 * @param sourceMapper - Maps each test file to the path it is shown by.
 */
export function formatGapSummary(
	result: JestResult,
	sourceMapper?: SourceMapper,
): string | undefined {
	const blocked = listBlocked(result);
	if (blocked.length === 0) {
		return undefined;
	}

	const lines = blocked.flatMap(({ file, gaps, test }) => {
		const path = resolveDisplayPath(file.testFilePath, sourceMapper);
		const members = Object.entries(gaps)
			.sort(([a], [b]) => COLLATOR.compare(a, b))
			.map(([member, raises]) => `    ${member}  ${plural(raises, "raise")}`);
		return [
			test === undefined ? `  ${path}` : `  ${path} > ${testName(file, test)}`,
			...members,
		];
	});
	return [`Blocked (${blocked.length.toString()}):`, ...lines].join("\n");
}

function testName(file: TestFileResult, test: TestCaseResult): string {
	const namesakes = file.testResults.filter(({ fullName }) => fullName === test.fullName);
	if (namesakes.length === 1) {
		return test.fullName;
	}

	return `${test.fullName} #${String(file.testResults.indexOf(test) + 1)}`;
}

function plural(count: number, noun: string): string {
	return `${count.toString()} ${noun}${count === 1 ? "" : "s"}`;
}
