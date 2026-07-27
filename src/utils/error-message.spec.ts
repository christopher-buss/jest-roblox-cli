import { describe, expect, it } from "vitest";

import { errorMessage } from "./error-message.ts";

describe(errorMessage, () => {
	it("should read the message off an Error", () => {
		expect.assertions(1);

		expect(errorMessage(new Error("EISDIR: illegal operation"))).toBe(
			"EISDIR: illegal operation",
		);
	});

	it("should stringify a non-Error throw", () => {
		expect.assertions(1);

		expect(errorMessage("plain string throw")).toBe("plain string throw");
	});
});
