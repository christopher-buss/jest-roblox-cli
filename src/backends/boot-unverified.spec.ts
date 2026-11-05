import { describe, expect, it } from "vitest";

import { BootUnverifiedError } from "./boot-unverified.ts";

describe(BootUnverifiedError, () => {
	it("should name the budget in seconds when no probe completed", () => {
		expect.assertions(1);

		const error = new BootUnverifiedError({
			booted: undefined,
			budget: 29_600,
			versionNumber: 7,
		});

		expect(error.message).toBe(
			"Place version 7 is boot unverified: no boot probe completed within 30s. No tests were submitted.",
		);
	});

	it("should quote what a completed probe reported", () => {
		expect.assertions(1);

		const error = new BootUnverifiedError({
			booted: "stale",
			budget: 30_000,
			versionNumber: 12,
		});

		expect(error.message).toBe(
			'Place version 12 is boot unverified: the boot probe reported "stale". No tests were submitted.',
		);
	});
});
