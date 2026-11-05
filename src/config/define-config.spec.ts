import { describe, expect, it } from "vitest";

import { defineConfig, defineProject } from "./define-config.ts";

describe(defineConfig, () => {
	it("should return the config object unchanged", () => {
		expect.assertions(1);

		const config = { backend: "studio" as const, test: { verbose: true } };

		expect(defineConfig(config)).toBe(config);
	});

	it("should return an empty config unchanged", () => {
		expect.assertions(1);

		const config = {};

		expect(defineConfig(config)).toBe(config);
	});

	it("should accept merger functions for test.* array fields", () => {
		expect.assertions(1);

		const config = defineConfig({
			test: {
				setupFiles: (defaults) => {
					return [...defaults, "extra.luau"];
				},
			},
		});

		expect(config.test!.setupFiles).toBeFunction();
	});
});

describe(defineProject, () => {
	it("should return the project config unchanged", () => {
		expect.assertions(1);

		const config = { test: { displayName: "client", include: ["src/client"] } };

		expect(defineProject(config)).toBe(config);
	});

	it("should accept displayName as string", () => {
		expect.assertions(1);

		const config = { test: { displayName: "server", include: ["src/server"] } };
		const result = defineProject(config);

		expect(result.test.displayName).toBe("server");
	});

	it("should accept displayName as object with name and color", () => {
		expect.assertions(1);

		const config = {
			test: {
				displayName: { name: "shared", color: "blue" },
				include: ["src/shared"],
			},
		};
		const result = defineProject(config);

		expect(result.test.displayName).toStrictEqual({ name: "shared", color: "blue" });
	});
});
