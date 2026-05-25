/* eslint-disable vitest/prefer-each, vitest/prefer-expect-assertions -- benchmarks are not tests: `bench` declares no assertions and loops to parametrize input size */
import { bench, describe } from "vitest";

import type { Config } from "./schema.ts";
import { buildWorkspaceRunOptions } from "./workspace-run-options.ts";

// `buildWorkspaceRunOptions` runs ~13 consensus passes per invocation, each
// O(packages) with a deep-equal group match. This bench guards the agreeing-
// packages path (the common case) against scaling regressions as the selected
// package set grows.
function agreeingConfigs(count: number): Array<{ config: Config; name: string }> {
	const configs: Array<{ config: Config; name: string }> = [];
	for (let index = 0; index < count; index++) {
		configs.push({
			name: `@scope/pkg-${String(index)}`,
			config: {
				backend: "open-cloud",
				color: true,
				formatters: ["json"],
				parallel: 4,
				port: 3001,
			},
		});
	}

	return configs;
}

const WORKSPACE_ROOT = "/repo";

describe(buildWorkspaceRunOptions, () => {
	for (const count of [10, 50, 200]) {
		const perPackageConfigs = agreeingConfigs(count);
		bench(`${String(count)} agreeing packages`, () => {
			buildWorkspaceRunOptions({ cli: {}, perPackageConfigs, workspaceRoot: WORKSPACE_ROOT });
		});
	}
});
