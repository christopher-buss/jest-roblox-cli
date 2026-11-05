import { RateLimitError } from "@bedrock-rbx/ocale";
import { TaskQuotaError, TaskStallError } from "@isentinel/roblox-runner";

import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import {
	formatInfrastructureBanner,
	isInfrastructureFailure,
	MissingGapRecordError,
} from "./infrastructure-failure.ts";

function createStall(): TaskStallError {
	return new TaskStallError({
		error: new Error("Execution timed out"),
		evidence: {
			createTime: undefined,
			kind: "task-stall",
			observedStates: ["PROCESSING"],
			placeVersion: undefined,
			task: "universes/1/places/2/luau-execution-sessions/s/tasks/t",
			timeoutSeconds: 300,
			updateTime: undefined,
		},
		readResultAsync: async () => ({ durationMs: 0, outputs: [] }),
	});
}

describe(isInfrastructureFailure, () => {
	it("should accept each infrastructure failure and reject any other error", () => {
		expect.assertions(3);

		expect(isInfrastructureFailure(createStall())).toBeTrue();
		expect(isInfrastructureFailure(new MissingGapRecordError("lost"))).toBeTrue();
		expect(isInfrastructureFailure(new Error("other"))).toBeFalse();
	});
});

describe(formatInfrastructureBanner, () => {
	it("should render a missing gap record without evidence", () => {
		expect.assertions(3);

		const banner = stripVTControlCharacters(
			formatInfrastructureBanner(new MissingGapRecordError("The run has no gap record")),
		);

		expect(banner).toContain("Missing Gap Record");
		expect(banner).toContain("The run has no gap record");
		expect(banner).not.toContain("Evidence:");
	});

	it("should omit evidence fields Roblox did not report", () => {
		expect.assertions(1);

		const banner = stripVTControlCharacters(formatInfrastructureBanner(createStall()));

		expect(banner).toContain(
			[
				"    task: universes/1/places/2/luau-execution-sessions/s/tasks/t",
				"    timeoutSeconds: 300",
				"    observedStates: PROCESSING",
			].join("\n"),
		);
	});

	it("should report a quota-refused create with its evidence and headers", () => {
		expect.assertions(2);

		const refused = new TaskQuotaError({
			cause: new RateLimitError("Rate limited", { retryAfterSeconds: 1856, statusCode: 429 }),
			evidence: {
				code: "RESOURCE_EXHAUSTED",
				headers: { "retry-after": "1856" },
				kind: "create-quota",
				placeVersion: 42,
				retryAfterSeconds: 1856,
				timeoutSeconds: 300,
				unlockTime: "2026-09-23T10:30:56.000Z",
			},
			message: "RESOURCE_EXHAUSTED: dmaas (Too Many Requests)",
		});

		const banner = stripVTControlCharacters(formatInfrastructureBanner(refused));

		expect(banner).toContain("Roblox Infrastructure Error");
		expect(banner).toContain(
			[
				"  Evidence:",
				"    kind: create-quota",
				"    unlockTime: 2026-09-23T10:30:56.000Z",
				"    retryAfterSeconds: 1856",
				"    code: RESOURCE_EXHAUSTED",
				"    placeVersion: 42",
				"    timeoutSeconds: 300",
				"    headers:",
				"      retry-after: 1856",
			].join("\n"),
		);
	});
});
