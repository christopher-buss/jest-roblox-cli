import type { InfrastructureEvidence } from "@isentinel/roblox-runner";
import { TaskQuotaError, TaskStallError } from "@isentinel/roblox-runner";

import color from "tinyrainbow";

import { formatBanner } from "./banner.ts";

/**
 * The exit code of a run its infrastructure failed, so a caller can tell it
 * from a test failure (1) or a run error (2) without reading the output.
 */
export const INFRASTRUCTURE_EXIT_CODE = 3;

/** An error that means Roblox infrastructure, not the tests, failed the run. */
export type InfrastructureFailure = MissingGapRecordError | TaskQuotaError | TaskStallError;

/**
 * A run whose gap record does not cover its results, so no test of it can be
 * called clean.
 */
export class MissingGapRecordError extends Error {}

/**
 * Whether a thrown value is an infrastructure failure.
 * @param err - The thrown value.
 * @returns True for a task stall, task quota or missing gap record error.
 */
export function isInfrastructureFailure(err: unknown): err is InfrastructureFailure {
	return (
		err instanceof TaskStallError ||
		err instanceof TaskQuotaError ||
		err instanceof MissingGapRecordError
	);
}

/**
 * Render the error banner for an infrastructure failure, with its evidence.
 * @param err - The infrastructure failure.
 * @returns The banner text.
 */
export function formatInfrastructureBanner(err: InfrastructureFailure): string {
	if (err instanceof MissingGapRecordError) {
		return formatBanner({
			body: [color.red(err.message)],
			level: "error",
			title: "Missing Gap Record",
		});
	}

	const body = [
		color.red(err.message),
		`\n  ${color.dim("Evidence:")}`,
		...describeEvidence(err.evidence),
	];
	return formatBanner({ body, level: "error", title: "Roblox Infrastructure Error" });
}

function listFields(
	evidence: InfrastructureEvidence,
): Array<[name: string, value: number | string | undefined]> {
	if (evidence.kind === "task-stall") {
		return [
			["task", evidence.task],
			["placeVersion", evidence.placeVersion],
			["timeoutSeconds", evidence.timeoutSeconds],
			["createTime", evidence.createTime],
			["updateTime", evidence.updateTime],
			["observedStates", evidence.observedStates.join(", ")],
		];
	}

	return [
		["unlockTime", evidence.unlockTime],
		["retryAfterSeconds", evidence.retryAfterSeconds],
		["code", evidence.code],
		["placeVersion", evidence.placeVersion],
		["timeoutSeconds", evidence.timeoutSeconds],
	];
}

/**
 * One line per field, in the order a Roblox bug report reads them.
 * @param evidence - What the runner recorded about the failure.
 * @returns The indented evidence lines.
 */
function describeEvidence(evidence: InfrastructureEvidence): Array<string> {
	const lines = [`    kind: ${evidence.kind}`];
	for (const [name, value] of listFields(evidence)) {
		if (value !== undefined) {
			lines.push(`    ${name}: ${String(value)}`);
		}
	}

	if (evidence.kind === "create-quota") {
		lines.push("    headers:");
		for (const [name, value] of Object.entries(evidence.headers)) {
			lines.push(`      ${name}: ${value}`);
		}
	}

	return lines;
}
