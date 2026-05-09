import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import {
	classifyTestFiles,
	discoverTestFiles,
	resolveSetupFilePaths,
	TYPE_TEST_PATTERN,
} from "./discovery.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});
vi.mock(import("../config/setup-resolver"));

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		rootDir: "/project",
		testMatch: ["**/*.spec.ts"],
		testPathIgnorePatterns: [],
		...overrides,
	};
}

function resetVol(): void {
	onTestFinished(() => {
		vol.reset();
	});
}

describe("tYPE_TEST_PATTERN", () => {
	it.for([
		["foo.test-d.ts", true],
		["foo.spec-d.ts", true],
		["foo.test.ts", false],
		["foo.spec.ts", false],
		["foo.spec-d.tsx", false],
	] as const)("should match %s = %s", ([file, expected]) => {
		expect.assertions(1);

		expect(TYPE_TEST_PATTERN.test(file)).toBe(expected);
	});
});

describe(discoverTestFiles, () => {
	it("should return CLI files resolved against rootDir when provided", () => {
		expect.assertions(1);

		const config = makeConfig();
		const result = discoverTestFiles(config, ["a.spec.ts", "sub/b.spec.ts"]);

		expect(result).toStrictEqual({
			files: [
				path.resolve("/project", "a.spec.ts"),
				path.resolve("/project", "sub/b.spec.ts"),
			],
			totalFiles: 2,
		});
	});

	it("should treat empty cliFiles as no override", () => {
		expect.assertions(1);

		resetVol();
		vol.mkdirSync("/project", { recursive: true });
		vol.writeFileSync("/project/a.spec.ts", "");
		const config = makeConfig();
		const result = discoverTestFiles(config, []);

		expect(result.files).toStrictEqual(["a.spec.ts"]);
	});

	it("should glob testMatch patterns under rootDir", () => {
		expect.assertions(1);

		resetVol();
		vol.mkdirSync("/project/src", { recursive: true });
		vol.writeFileSync("/project/src/a.spec.ts", "");
		vol.writeFileSync("/project/src/b.spec.ts", "");
		vol.writeFileSync("/project/src/c.test.ts", "");
		const config = makeConfig({ testMatch: ["**/*.spec.ts"] });
		const result = discoverTestFiles(config);

		expect(result.files.toSorted()).toStrictEqual(["src/a.spec.ts", "src/b.spec.ts"]);
	});

	it("should exclude files matching testPathIgnorePatterns", () => {
		expect.assertions(2);

		resetVol();
		vol.mkdirSync("/project/src", { recursive: true });
		vol.writeFileSync("/project/src/a.spec.ts", "");
		vol.writeFileSync("/project/src/skip.spec.ts", "");
		const config = makeConfig({ testPathIgnorePatterns: ["skip"] });
		const result = discoverTestFiles(config);

		expect(result.files).toStrictEqual(["src/a.spec.ts"]);
		expect(result.totalFiles).toBe(1);
	});

	it("should filter by testPathPattern when set", () => {
		expect.assertions(2);

		resetVol();
		vol.mkdirSync("/project/src", { recursive: true });
		vol.writeFileSync("/project/src/keep.spec.ts", "");
		vol.writeFileSync("/project/src/other.spec.ts", "");
		const config = makeConfig({ testPathPattern: "keep" });
		const result = discoverTestFiles(config);

		expect(result.files).toStrictEqual(["src/keep.spec.ts"]);
		expect(result.totalFiles).toBe(2);
	});

	it("should dedupe overlapping testMatch matches", () => {
		expect.assertions(1);

		resetVol();
		vol.mkdirSync("/project", { recursive: true });
		vol.writeFileSync("/project/a.spec.ts", "");
		const config = makeConfig({ testMatch: ["**/*.spec.ts", "*.spec.ts"] });
		const result = discoverTestFiles(config);

		expect(result.files).toStrictEqual(["a.spec.ts"]);
	});
});

describe(classifyTestFiles, () => {
	const files = ["a.spec.ts", "b.spec-d.ts", "c.test-d.ts", "d.test.ts"];

	it("should exclude type test files from runtime even when typecheck is off", () => {
		expect.assertions(1);

		const config = makeConfig({ typecheck: false, typecheckOnly: false });

		expect(classifyTestFiles(files, config)).toStrictEqual({
			runtimeFiles: ["a.spec.ts", "d.test.ts"],
			typeTestFiles: [],
		});
	});

	it("should split runtime and type test files when typecheck is on", () => {
		expect.assertions(1);

		const config = makeConfig({ typecheck: true });

		expect(classifyTestFiles(files, config)).toStrictEqual({
			runtimeFiles: ["a.spec.ts", "d.test.ts"],
			typeTestFiles: ["b.spec-d.ts", "c.test-d.ts"],
		});
	});

	it("should return no runtime files when typecheckOnly is set", () => {
		expect.assertions(1);

		const config = makeConfig({ typecheck: true, typecheckOnly: true });

		expect(classifyTestFiles(files, config)).toStrictEqual({
			runtimeFiles: [],
			typeTestFiles: ["b.spec-d.ts", "c.test-d.ts"],
		});
	});
});

describe(resolveSetupFilePaths, () => {
	it("should be a no-op when no setup files are configured", async () => {
		expect.assertions(1);

		const { createSetupResolver } = await import("../config/setup-resolver");
		const config = makeConfig();
		resolveSetupFilePaths(config);

		expect(createSetupResolver).not.toHaveBeenCalled();
	});

	it("should rewrite setupFiles via the resolver", async () => {
		expect.assertions(2);

		const { createSetupResolver } = await import("../config/setup-resolver");
		vi.mocked(createSetupResolver).mockReturnValue((input: string) => `resolved:${input}`);
		const config = makeConfig({ setupFiles: ["./a.ts"] });
		resolveSetupFilePaths(config);

		expect(config.setupFiles).toStrictEqual(["resolved:./a.ts"]);
		expect(createSetupResolver).toHaveBeenCalledWith({
			configDirectory: "/project",
			rojoConfigPath: path.resolve("/project", "default.project.json"),
		});
	});

	it("should rewrite setupFilesAfterEnv via the resolver", async () => {
		expect.assertions(1);

		const { createSetupResolver } = await import("../config/setup-resolver");
		vi.mocked(createSetupResolver).mockReturnValue((input: string) => `r:${input}`);
		const config = makeConfig({ setupFilesAfterEnv: ["./post.ts"] });
		resolveSetupFilePaths(config);

		expect(config.setupFilesAfterEnv).toStrictEqual(["r:./post.ts"]);
	});

	it("should use config.rojoProject when supplied", async () => {
		expect.assertions(1);

		const { createSetupResolver } = await import("../config/setup-resolver");
		vi.mocked(createSetupResolver).mockReturnValue((input: string) => input);
		const config = makeConfig({
			rojoProject: "custom.project.json",
			setupFiles: ["./a.ts"],
		});
		resolveSetupFilePaths(config);

		expect(createSetupResolver).toHaveBeenCalledWith({
			configDirectory: "/project",
			rojoConfigPath: path.resolve("/project", "custom.project.json"),
		});
	});
});
