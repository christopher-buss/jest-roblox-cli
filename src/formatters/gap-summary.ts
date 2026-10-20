import type { GapTally } from "../backends/interface.ts";
import { hasExecError, type JestResult } from "../types/jest-result.ts";

interface RankedGap {
	blocked: number;
	member: string;
	raises: number;
}

const COLLATOR = new Intl.Collator();
const REGEX_SPECIAL = /[$()*+.?[\\\]^{|}]/g;

/**
 * The end-of-run summary of the members a run does not emulate, largest
 * first by the tests each one blocked. Undefined when the run hit none.
 *
 * A test is blocked by a member when its failure names `NotEmulated: member`;
 * a suite that failed to run counts once.
 */
export function formatGapSummary(
	gaps: GapTally | undefined,
	result: JestResult,
): string | undefined {
	if (gaps === undefined) {
		return undefined;
	}

	const tallies = Object.entries(gaps);
	if (tallies.length === 0) {
		return undefined;
	}

	const failures = collectFailures(result);
	const ranked: Array<RankedGap> = tallies.map(([member, raises]) => {
		const pattern = new RegExp(
			`NotEmulated: ${member.replace(REGEX_SPECIAL, "\\$&")}(?![\\w.])`,
		);
		return {
			blocked: failures.filter((failure) => pattern.test(failure)).length,
			member,
			raises,
		};
	});
	ranked.sort((a, b) => {
		return b.blocked - a.blocked || b.raises - a.raises || COLLATOR.compare(a.member, b.member);
	});

	const width = Math.max(...ranked.map((gap) => gap.member.length));
	const lines = ranked.map((gap) => {
		return `  ${gap.member.padEnd(width)}  ${plural(gap.blocked, "test")} blocked, ${plural(gap.raises, "raise")}`;
	});
	return [`Not emulated (${ranked.length.toString()}):`, ...lines].join("\n");
}

function collectFailures(result: JestResult): Array<string> {
	return result.testResults.flatMap((file) => {
		if (hasExecError(file)) {
			return [file.failureMessage];
		}

		return file.testResults
			.filter((test) => test.status === "failed")
			.map((test) => test.failureMessages.join("\n"));
	});
}

function plural(count: number, noun: string): string {
	return `${count.toString()} ${noun}${count === 1 ? "" : "s"}`;
}
