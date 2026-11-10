import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { resolveSnapshotFormat } from "./snapshot-format.ts";

// A directory that does not exist, so the tsconfig scan finds nothing and each
// case turns on its test files alone. The tsconfig half of the decision is
// `resolveAllTsconfigMappings`, covered against a seeded filesystem in
// `executor.spec.ts`.
const ROOT = path.resolve("/jest-roblox-no-such-package");

function configWithRoot(overrides: Partial<ResolvedConfig> = {}) {
	return { ...createResolvedConfig(), rootDir: ROOT, ...overrides };
}

function resolve(config: ResolvedConfig, testFiles: Array<string>) {
	return resolveSnapshotFormat({
		cache: new Map(),
		config,
		fileSystem: createMemoryFileSystem().fileSystem,
		testFiles,
		tsconfigReader: () => null,
	});
}

describe(resolveSnapshotFormat, () => {
	it("should print the basic prototype for a luau project", () => {
		expect.assertions(1);

		const result = resolve(configWithRoot(), ["src/a.spec.luau"]);

		expect(result.snapshotFormat!.printBasicPrototype).toBeTrue();
	});

	it("should omit the basic prototype for a typescript project", () => {
		expect.assertions(1);

		const result = resolve(configWithRoot(), ["src/a.spec.ts"]);

		expect(result.snapshotFormat!.printBasicPrototype).toBeFalse();
	});

	it("should preserve an explicit printBasicPrototype", () => {
		expect.assertions(1);

		const config = configWithRoot({ snapshotFormat: { printBasicPrototype: true } });

		const result = resolve(config, ["src/a.spec.ts"]);

		expect(result.snapshotFormat!.printBasicPrototype).toBeTrue();
	});

	it("should keep sibling snapshotFormat options", () => {
		expect.assertions(2);

		const config = configWithRoot({ snapshotFormat: { escapeString: true } });

		const result = resolve(config, ["src/a.spec.ts"]);

		expect(result.snapshotFormat!.escapeString).toBeTrue();
		expect(result.snapshotFormat!.printBasicPrototype).toBeFalse();
	});

	it("should not mutate the config it is given", () => {
		expect.assertions(1);

		const config = configWithRoot();

		resolve(config, ["src/a.spec.luau"]);

		expect(config.snapshotFormat).toBeUndefined();
	});
});
