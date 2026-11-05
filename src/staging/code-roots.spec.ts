import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { posixRoot } from "#test/mocks/posix-path.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import type { CodeRootsRequest } from "./code-roots.ts";
import { resolveCodeRoots } from "./code-roots.ts";

const STAGING_DIRECTORY = "/repo/.jest-roblox";

/**
 * A config naming its own roots, so nothing has to be detected off disk.
 * @param rootDirectory - The config's `rootDir`.
 * @param luauRoots - Roots the config names.
 * @returns A resolved config over the defaults.
 */
function projectConfig(rootDirectory: string, luauRoots?: Array<string>): ResolvedConfig {
	return {
		...createResolvedConfig(),
		luauRoots,
		rojoProject: "none.project.json",
		rootDir: rootDirectory,
	};
}

function resolve(
	configs: Array<ResolvedConfig>,
	gate: Partial<Pick<CodeRootsRequest, "backendKind" | "exclusivePlace">> = {},
): Array<PosixRoot> | undefined {
	const { fileSystem } = createMemoryFileSystem();
	return resolveCodeRoots({
		backendKind: "open-cloud",
		configs,
		exclusivePlace: true,
		fileSystem,
		stagingDirectory: STAGING_DIRECTORY,
		/**
		 * A project with no roots of its own must not reach a real tsconfig on
		 * the machine running the spec.
		 * @returns No tsconfig.
		 */
		tsconfigReader: () => null,
		...gate,
	});
}

/**
 * The one spelling a root arrives in, whatever the host calls its drive.
 * @param segments - Path segments to resolve.
 * @returns The resolved path as a posix root.
 */
function rootAt(...segments: Array<string>): PosixRoot {
	return posixRoot(path.resolve(...segments));
}

describe(resolveCodeRoots, () => {
	it("should take the staging directory whatever the projects say", () => {
		expect.assertions(1);

		expect(resolve([])).toStrictEqual([posixRoot(STAGING_DIRECTORY)]);
	});

	it("should resolve every project's roots against its own root directory", () => {
		expect.assertions(1);

		const roots = resolve([
			projectConfig("/repo", ["out"]),
			projectConfig("/repo/packages/ui", ["build/luau"]),
		]);

		expect(roots).toStrictEqual([
			posixRoot(STAGING_DIRECTORY),
			rootAt("/repo", "out"),
			rootAt("/repo/packages/ui", "build/luau"),
		]);
	});

	it("should read one directory once however many projects name it", () => {
		expect.assertions(1);

		const roots = resolve([projectConfig("/repo", ["out"]), projectConfig("/repo", ["out/"])]);

		expect(roots).toStrictEqual([posixRoot(STAGING_DIRECTORY), rootAt("/repo", "out")]);
	});

	it("should contribute nothing for a project whose roots cannot be found", () => {
		expect.assertions(1);

		// No `luauRoots`, no rojo project to read mounts off, and no tsconfig
		// `outDir` — a run that still works, so it must not be refused here.
		expect(resolve([projectConfig("/repo")])).toStrictEqual([posixRoot(STAGING_DIRECTORY)]);
	});

	// The gate lives here rather than in each dispatch mode, so neither mode can
	// decide on its own that a backend may be served a harness.
	it("should split nothing for a backend that opens the place itself", () => {
		expect.assertions(1);

		expect(
			resolve([projectConfig("/repo", ["out"])], { backendKind: "studio" }),
		).toBeUndefined();
	});

	it("should split nothing without an Exclusive Place, which is the default", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();

		expect(
			resolveCodeRoots({
				backendKind: "open-cloud",
				configs: [projectConfig("/repo", ["out"])],
				fileSystem,
				stagingDirectory: STAGING_DIRECTORY,
			}),
		).toBeUndefined();
	});
});
