import { describe, expect, it } from "vitest";

import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import { buildProjectRunPolicy } from "./project-run-policy.ts";

describe(buildProjectRunPolicy, () => {
	it("should preserve dispatch settings and root checker policy", () => {
		expect.assertions(1);

		const rootConfig = {
			...createResolvedConfig(),
			experimentalVmParallel: 2,
			parallel: 3,
			timeout: 654_321,
			typecheck: { enabled: true, ignoreSourceErrors: true, spawnTimeout: 4321 },
		};

		expect(buildProjectRunPolicy({ cliTypecheck: {}, rootConfig })).toStrictEqual({
			dispatch: { parallel: 3, vmParallel: 2 },
			typecheck: { ignoreSourceErrors: true, spawnTimeout: 4321, timeout: 654_321 },
		});
	});

	it("should preserve default checker and unset dispatch settings", () => {
		expect.assertions(1);

		const rootConfig = createResolvedConfig();

		expect(
			buildProjectRunPolicy({
				cliTypecheck: {},
				rootConfig,
			}),
		).toStrictEqual({
			dispatch: { parallel: undefined, vmParallel: undefined },
			typecheck: {
				ignoreSourceErrors: undefined,
				spawnTimeout: undefined,
				timeout: rootConfig.timeout,
			},
		});
	});
});
