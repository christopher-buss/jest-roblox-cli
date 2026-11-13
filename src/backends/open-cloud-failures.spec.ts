import { PermissionError } from "@bedrock-rbx/ocale";

import { assert, describe, expect, it } from "vitest";

import { describeError, isNotFoundError, rethrowOversizedResult } from "./open-cloud-failures.ts";

function caught(rethrow: () => never): unknown {
	try {
		rethrow();
	} catch (err) {
		return err;
	}
}

describe(rethrowOversizedResult, () => {
	it("should explain an oversized return that splitting cannot fix", () => {
		expect.assertions(2);

		// Open Cloud names neither the cause nor a way out, and it rejects
		// the whole task. Every package that task ran is lost with it. A
		// run reaching here is either single-task or has one package whose
		// own results exceed the cap, so the remedy has to be spelled out.
		const cause = new Error(
			"Return results too large. Please reduce return result length to 4194304. Current size: 5908004",
		);

		const thrown = caught(() => rethrowOversizedResult(cause));
		assert(thrown instanceof Error);

		expect(thrown.message).toBe(
			[
				cause.message,
				"One task returned more Jest output than Open Cloud accepts (4 MiB).",
				"Coverage is usually the bulk of it. Try --no-coverage to confirm.",
				"Only files in the coverage universe are probed, so narrowing `collectCoverageFrom` to what you actually report on shrinks the payload with it.",
				'Otherwise set `parallel: "auto"` (or --parallel 2+) so results come back split across tasks, or narrow the run with --packages / --project.',
			].join("\n"),
		);
		expect(thrown.cause).toBe(cause);
	});

	it.for([new Error("open cloud task crashed"), "Return results too large"])(
		"should leave an unrelated failure untouched: %s",
		(failure) => {
			expect.assertions(1);

			expect(caught(() => rethrowOversizedResult(failure))).toBe(failure);
		},
	);
});

describe(describeError, () => {
	it("should name the scopes a permission failure is missing", () => {
		expect.assertions(1);

		const err = new Error("forbidden", {
			cause: new PermissionError("forbidden", {
				operationKey: "memory-store-sorted-maps.list",
				requiredScopes: ["scope-a", "scope-b"],
				statusCode: 403,
			}),
		});

		expect(describeError(err)).toContain("missing scopes scope-a, scope-b");
	});

	it.for([
		[new Error("network broke"), "network broke"],
		["string-error", "string-error"],
	] as const)("should describe %s as %s", ([err, expected]) => {
		expect.assertions(1);

		expect(describeError(err)).toBe(expected);
	});
});

describe(isNotFoundError, () => {
	it("should find a 404 anywhere in the error chain", () => {
		expect.assertions(2);

		const notFound = Object.assign(new Error("missing"), { statusCode: 404 });

		expect(isNotFoundError(new Error("outer", { cause: notFound }))).toBeTrue();
		expect(isNotFoundError(new Error("other"))).toBeFalse();
	});
});
