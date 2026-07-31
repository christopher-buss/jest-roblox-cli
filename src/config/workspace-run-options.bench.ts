/* eslint-disable flawless/prefer-ending-with-an-expect, vitest/consistent-test-it, vitest/expect-expect, vitest/prefer-expect-assertions, vitest/valid-title -- the eslint plugin still models `bench` as a Vitest 4 top-level test. It now registers a measurement inside the host test, so the assertion and title rules aim at the wrong call, and the host itself measures rather than asserts. */
import { describe, it } from "vitest";

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

const PACKAGE_COUNTS = [10, 50, 200];

describe(buildWorkspaceRunOptions, () => {
	it("should benchmark the agreeing-packages consensus path", async ({ bench }) => {
		await bench.compare(
			...PACKAGE_COUNTS.map((count) => {
				const perPackageConfigs = agreeingConfigs(count);
				return bench(`${String(count)} packages`, () => {
					buildWorkspaceRunOptions({
						cli: {},
						perPackageConfigs,
						workspaceRoot: WORKSPACE_ROOT,
					});
				});
			}),
		);
	});
});
