import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedTypecheckConfig } from "../config/resolve-typecheck-config.ts";
import { buildPendingEntry, type ProjectCliFiles } from "./pending-entry.ts";
import type { PackageContext } from "./project-contexts.ts";

const PACKAGE_DIRECTORY = path.resolve("/workspace/foo");

interface EntryOptions {
	cliFiles?: ProjectCliFiles;
	testPathPattern?: string;
	typecheck?: Partial<ResolvedTypecheckConfig>;
}

function makeProject(): ResolvedProjectConfig {
	return fromAny({
		config: { ...createResolvedConfig(), timeout: 4321 },
		displayName: "main",
		exclude: ["src/skip/**"],
		include: ["src/**/*.spec.luau"],
		projects: ["ServerScriptService/main"],
		rojoMounts: [{ dataModelPath: "ServerScriptService/main", fsPath: "src" }],
		testMatch: ["**/*.spec"],
	});
}

function makeContext(testPathPattern: string | undefined): PackageContext {
	return fromAny({
		info: { name: "@halcyon/foo", packageDirectory: PACKAGE_DIRECTORY },
		pkgConfig: {
			...createResolvedConfig(),
			passWithNoTests: false,
			rootDir: PACKAGE_DIRECTORY,
			testPathPattern,
		},
	});
}

function build({ cliFiles, testPathPattern, typecheck }: EntryOptions = {}) {
	const { fileSystem } = createMemoryFileSystem({
		[path.join(PACKAGE_DIRECTORY, "src/a/one.spec.luau")]: "",
		[path.join(PACKAGE_DIRECTORY, "src/b/two.spec.luau")]: "",
		[path.join(PACKAGE_DIRECTORY, "src/skip/three.spec.luau")]: "",
	});
	const project = makeProject();
	project.config.testPathPattern = testPathPattern;
	return buildPendingEntry({
		cliFiles,
		ctx: makeContext(testPathPattern),
		fileSystem,
		globCache: { leaves: undefined, walks: new Map() },
		project,
		tsconfigCache: new Map(),
		typecheck: { enabled: false, only: false, ...typecheck },
	});
}

describe(buildPendingEntry, () => {
	it("should glob the project include minus its exclude", () => {
		expect.assertions(4);

		const entry = build();

		expect(entry.pkg).toBe("@halcyon/foo");
		expect(entry.testFiles.toSorted()).toStrictEqual([
			"src/a/one.spec.luau",
			"src/b/two.spec.luau",
		]);
		expect(entry.projectConfig.testPathPattern).toBeUndefined();
		expect(entry.projectConfig).toMatchObject({
			passWithNoTests: false,
			projects: ["ServerScriptService/main"],
			rootDir: PACKAGE_DIRECTORY,
			testMatch: ["**/*.spec"],
			timeout: 4321,
		});
	});

	it("should discover no runtime files for a typecheck-only project", () => {
		expect.assertions(1);

		expect(build({ typecheck: { enabled: true, only: true } }).testFiles).toStrictEqual([]);
	});

	it("should take positional files as-is and narrow to their instance path", () => {
		expect.assertions(2);

		const entry = build({
			cliFiles: { runtimeFiles: ["src/skip/three.spec.luau"], typeTestFiles: [] },
		});

		expect(entry.testFiles).toStrictEqual(["src/skip/three.spec.luau"]);
		expect(entry.projectConfig.testPathPattern).toBe("(main/skip/three\\.spec)");
	});

	it("should narrow a testPathPattern to the matched instance paths", () => {
		expect.assertions(1);

		const entry = build({ testPathPattern: "a/one" });

		expect(entry.projectConfig.testPathPattern).toBe("(main/a/one\\.spec)");
	});

	it("should keep a pattern that matches nothing and pass with no tests", () => {
		expect.assertions(2);

		const entry = build({ testPathPattern: "nowhere" });

		expect(entry.projectConfig.testPathPattern).toBe("nowhere");
		expect(entry.projectConfig.passWithNoTests).toBeTrue();
	});
});
