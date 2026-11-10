/* oxlint-disable vitest/expect-expect, vitest/prefer-expect-assertions -- the host test measures rather than asserts. */
/* eslint-disable flawless/prefer-ending-with-an-expect -- the host test measures rather than asserts. */
import { describe, it } from "vitest";

import { DEFAULT_CONFIG } from "#src/config/resolved-config.ts";
import { buildJestArgv, indexArgv } from "#src/runner-payload/jest-argv.ts";
import {
	generateMaterializerScript,
	type MaterializerInput,
} from "#src/runner-payload/materializer-script.ts";

/**
 * The materializer payload is built once per workspace run and grows with the
 * package count. This bench guards the JSON substitution against regressions
 * as the workspace scales.
 * @param packageCount - Number of packages.
 * @returns Synthetic materializer inputs.
 */
function materializerInputs(packageCount: number): Array<MaterializerInput> {
	return Array.from({ length: packageCount }, (_unused, index) => {
		const packageName = `@scope/pkg-${String(index)}`;
		return {
			config: indexArgv(
				buildJestArgv({
					config: { ...DEFAULT_CONFIG, rootDir: `/repo/packages/pkg-${String(index)}` },
				}),
				index,
			),
			pkg: packageName,
			project: packageName,
		};
	});
}

const PACKAGE_COUNTS = [10, 50, 200];

describe(generateMaterializerScript, () => {
	it("should benchmark the materializer payload build", async ({ bench }) => {
		await bench.compare(
			...PACKAGE_COUNTS.map((count) => {
				const inputs = materializerInputs(count);
				return bench(`${String(count)} packages`, () => {
					generateMaterializerScript(inputs);
				});
			}),
		);
	});
});
