import { isAgent } from "std-env";
import { describe, expect, it, vi } from "vitest";

import { defaultFormatters } from "./default-formatters.ts";

const STD_ENVIRONMENT_DEFAULT = isAgent ? "agent" : "default";

describe(defaultFormatters, () => {
	it("should pick the default formatter outside an agent runtime", () => {
		expect.assertions(1);

		expect(defaultFormatters(false)).toStrictEqual(["default"]);
	});

	it("should pick the agent formatter inside an agent runtime", () => {
		expect.assertions(1);

		expect(defaultFormatters(true)).toStrictEqual(["agent"]);
	});

	it("should append github-actions inside GitHub Actions", () => {
		expect.assertions(2);

		vi.stubEnv("GITHUB_ACTIONS", "true");

		expect(defaultFormatters(false)).toStrictEqual(["default", "github-actions"]);
		expect(defaultFormatters(true)).toStrictEqual(["agent", "github-actions"]);
	});

	it("should read the agent runtime from std-env when none is passed", () => {
		expect.assertions(1);

		expect(defaultFormatters()).toStrictEqual([STD_ENVIRONMENT_DEFAULT]);
	});
});
