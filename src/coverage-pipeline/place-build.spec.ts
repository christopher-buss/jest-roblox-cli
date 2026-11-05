import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { CODE_SPLIT_PASS_VERSION } from "#test/mocks/coverage-versions.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { describeCodeSplit, reuseCodeBundle } from "./place-build.ts";

describe(describeCodeSplit, () => {
	it("should answer nothing for a run that builds the whole place", () => {
		expect.assertions(1);

		expect(describeCodeSplit(undefined)).toBeUndefined();
	});

	it("should fold the pass version and each Code Root into one key", () => {
		expect.assertions(1);

		expect(describeCodeSplit([posixRoot("out/a"), posixRoot("out/b")])).toBe(
			`${CODE_SPLIT_PASS_VERSION}\nout/a\nout/b`,
		);
	});
});

describe(reuseCodeBundle, () => {
	it("should answer no bundle for a run that builds the whole place", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const childProcess: ChildProcessRunner = fromAny({});

		expect(
			reuseCodeBundle({
				childProcess,
				codeRoots: undefined,
				fileSystem,
				packageDirectory: "/project",
				rojoProjectPath: "/project/default.project.json",
				shadow: { coverageRoots: [], coverageSpine: [] },
				stubMounts: [],
			}),
		).toBeUndefined();
	});
});
