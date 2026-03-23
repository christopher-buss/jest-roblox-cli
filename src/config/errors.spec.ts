import { describe, expect, it } from "vitest";

import { ConfigError } from "./errors.ts";

describe(ConfigError, () => {
	it("should store message and hint", () => {
		expect.assertions(2);

		const err = new ConfigError("bad config", "try setting outDir");

		expect(err.message).toBe("bad config");
		expect(err.hint).toBe("try setting outDir");
	});

	it("should allow omitting hint", () => {
		expect.assertions(2);

		const err = new ConfigError("bad config");

		expect(err.message).toBe("bad config");
		expect(err.hint).toBeUndefined();
	});

	it("should be an instance of Error", () => {
		expect.assertions(1);

		const err = new ConfigError("bad config");

		expect(err).toBeInstanceOf(Error);
	});
});
