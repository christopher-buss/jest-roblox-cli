import { describe, expect, it } from "vitest";

import type { IndexedJestArgv } from "./jest-argv.ts";
import { generateTestScript } from "./test-script.ts";

function createArgv(overrides: Partial<IndexedJestArgv> = {}): IndexedJestArgv {
	return { runnerJobIndex: 0, testMatch: ["**/*.spec"], ...overrides };
}

describe(generateTestScript, () => {
	it("should contain Jest.runCLI call", () => {
		expect.assertions(1);

		const script = generateTestScript([createArgv()]);

		expect(script).toContain("Jest.runCLI");
	});

	it("should embed config as JSON", () => {
		expect.assertions(5);

		const script = generateTestScript([createArgv({ verbose: true })]);

		expect(script).toContain("JSONDecode");
		expect(script).toContain('"verbose":true');
		expect(script).toStartWith("--!strict\n");
		expect(script).toMatch(/^local __WELD_MODULES = \{/mu);
		expect(script).not.toContain("__CONFIG_JSON__");
	});

	it("should keep a test name pattern holding a long-string terminator inside the payload", () => {
		expect.assertions(1);

		const argv = createArgv({ testNamePattern: "a]=]b" });

		const script = generateTestScript([argv]);

		expect(script).toContain(`[==[${JSON.stringify({ configs: [argv] })}]==]`);
	});

	it("should embed one argv per config of a bucket", () => {
		expect.assertions(1);

		const first = createArgv({ testMatch: ["a/**/*.spec"] });
		const second = createArgv({ testMatch: ["b/**/*.spec"] });

		const script = generateTestScript([first, second]);

		expect(script).toContain(JSON.stringify({ configs: [first, second] }));
	});
});
