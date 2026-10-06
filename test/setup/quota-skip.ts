import { TaskQuotaError } from "@isentinel/roblox-runner";

import type { TestContext } from "vitest";

import { NOTE_PREFIX } from "./quota-skip-reporter.ts";

const INFRASTRUCTURE_EXIT_CODE = 3;
const MINUTE_WINDOW_SECONDS = 60;
const UNLOCK_TIME_PATTERN = /unlockTime: (\S+)/;
const RETRY_AFTER_PATTERN = /retry-after=(\d+)/;

interface CliResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

export function quotaSkipNote(result: CliResult): string | undefined {
	if (result.exitCode !== INFRASTRUCTURE_EXIT_CODE) {
		return undefined;
	}

	if (!result.stderr.includes("kind: create-quota")) {
		return undefined;
	}

	const unlockTime = UNLOCK_TIME_PATTERN.exec(result.stderr)?.[1] ?? "an unknown time";
	return `${NOTE_PREFIX} Roblox refused the task create until ${unlockTime}`;
}

export async function skipOnQuotaAsync<T>(context: TestContext, run: Promise<T>): Promise<T> {
	try {
		return await run;
	} catch (err) {
		const note = quotaErrorNote(err);
		context.skip(note !== undefined, note);
		throw err;
	}
}

function isLockoutRefusal(message: string): boolean {
	const retryAfter = Number(RETRY_AFTER_PATTERN.exec(message)?.[1]);
	return (
		message.includes("status=429;") &&
		message.includes("RESOURCE_EXHAUSTED") &&
		retryAfter > MINUTE_WINDOW_SECONDS
	);
}

function quotaErrorNote(err: unknown): string | undefined {
	if (err instanceof TaskQuotaError) {
		return `${NOTE_PREFIX} Roblox refused the task create until ${err.evidence.unlockTime}`;
	}

	if (!(err instanceof Error) || !isLockoutRefusal(err.message)) {
		return undefined;
	}

	return `${NOTE_PREFIX} Roblox refused the task create beyond its per-minute limit`;
}
