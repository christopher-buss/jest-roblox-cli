/* eslint-disable flawless/prefer-ending-with-an-expect, vitest/consistent-test-it, vitest/expect-expect, vitest/prefer-expect-assertions, vitest/valid-title -- the eslint plugin still models `bench` as a Vitest 4 top-level test. It now registers a measurement inside the host test, so the assertion and title rules aim at the wrong call, and the host itself measures rather than asserts. */
import { describe, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/schema.ts";
import { generateMaterializerScript, type MaterializerInput } from "./test-script-staged.ts";

// The materializer payload is built once per workspace run and grows with the
// (package, project) count. This bench guards the per-entry `buildJestArgv` +
// JSON substitution against regressions as the workspace scales.
function materializerInputs(
	packageCount: number,
	filesPerPackage: number,
): Array<MaterializerInput> {
	const inputs: Array<MaterializerInput> = [];
	for (let index = 0; index < packageCount; index++) {
		const directory = `/repo/packages/pkg-${String(index)}`;
		const packageName = `@scope/pkg-${String(index)}`;
		const testFiles: Array<string> = [];
		for (let fileIndex = 0; fileIndex < filesPerPackage; fileIndex++) {
			testFiles.push(`${directory}/out/file-${String(fileIndex)}.spec.luau`);
		}

		inputs.push({
			config: { ...DEFAULT_CONFIG, rootDir: directory },
			pkg: packageName,
			project: packageName,
			testFiles,
		});
	}

	return inputs;
}

const PACKAGE_COUNTS = [10, 50, 200];

const FILES_PER_PACKAGE = 10;

describe(generateMaterializerScript, () => {
	it("should benchmark the materializer payload build", async ({ bench }) => {
		await bench.compare(
			...PACKAGE_COUNTS.map((count) => {
				const inputs = materializerInputs(count, FILES_PER_PACKAGE);
				return bench(`${String(count)} packages`, () => {
					generateMaterializerScript(inputs);
				});
			}),
		);
	});
});
