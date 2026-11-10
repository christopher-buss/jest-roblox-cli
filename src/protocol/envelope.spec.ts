import { type } from "arktype";
import { describe, expect, it } from "vitest";

import { encodeRunFailure, entryKey, taskEnvelopeSchema } from "./envelope.ts";

describe(encodeRunFailure, () => {
	it("should encode a failure with no runner block", () => {
		expect.assertions(1);

		expect(JSON.parse(encodeRunFailure("boom"))).toStrictEqual({ err: "boom", success: false });
	});

	it("should carry what the runner measured", () => {
		expect.assertions(1);

		expect(JSON.parse(encodeRunFailure("boom", { abandon: "timeout" }))).toStrictEqual({
			err: "boom",
			runner: { abandon: "timeout" },
			success: false,
		});
	});
});

describe("taskEnvelopeSchema", () => {
	it("should reject a scope other than batch", () => {
		expect.assertions(1);

		expect(taskEnvelopeSchema({ entries: [], gameOutputScope: "project" })).toBeInstanceOf(
			type.errors,
		);
	});
});

describe(entryKey, () => {
	it("should join package and project", () => {
		expect.assertions(1);

		expect(entryKey("@scope/pkg", "core")).toBe("@scope/pkg::core");
	});
});
