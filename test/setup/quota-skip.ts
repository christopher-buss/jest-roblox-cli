import { TaskQuotaError } from "@isentinel/roblox-runner";

import type { TestContext } from "vitest";

import { INFRASTRUCTURE_EXIT_CODE } from "#src/utils/infrastructure-failure.ts";
import { NOTE_PREFIX } from "#test/setup/quota-skip-reporter.ts";

const UNLOCK_TIME_PATTERN = /unlockTime: (\S+)/;

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

function quotaErrorNote(err: unknown): string | undefined {
	if (!(err instanceof TaskQuotaError)) {
		return undefined;
	}

	return `${NOTE_PREFIX} Roblox refused the task create until ${err.evidence.unlockTime}`;
}
