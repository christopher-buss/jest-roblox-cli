import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import type { PosixRoot } from "../utils/normalize-windows-path.ts";
import { toPosixRoot } from "../utils/normalize-windows-path.ts";
import type { CodeRootsRequest } from "./code-roots.ts";
import { resolveCodeRoots } from "./code-roots.ts";

const STAGING_DIRECTORY = "/repo/.jest-roblox";

/** A config naming its own roots, so nothing has to be detected off disk. */
function projectConfig(rootDirectory: string, luauRoots?: Array<string>): ResolvedConfig {
	return {
		...DEFAULT_CONFIG,
		luauRoots,
		rojoProject: "none.project.json",
		rootDir: rootDirectory,
	};
}

function resolve(
	configs: Array<ResolvedConfig>,
	gate: Partial<Pick<CodeRootsRequest, "backendKind" | "binaryInput">> = {},
): Array<PosixRoot> | undefined {
	const { fileSystem } = createMemoryFileSystem();
	return resolveCodeRoots({
		backendKind: "open-cloud",
		binaryInput: true,
		configs,
		fileSystem,
		stagingDirectory: STAGING_DIRECTORY,
		// A project with no roots of its own must not reach a real tsconfig on
		// the machine running the spec.
		tsconfigReader: () => null,
		...gate,
	});
}

/** The one spelling a root arrives in, whatever the host calls its drive. */
function rootAt(...segments: Array<string>): PosixRoot {
	return toPosixRoot(path.resolve(...segments));
}

describe(resolveCodeRoots, () => {
	it("should take the staging directory whatever the projects say", () => {
		expect.assertions(1);

		expect(resolve([])).toStrictEqual([toPosixRoot(STAGING_DIRECTORY)]);
	});

	it("should resolve every project's roots against its own root directory", () => {
		expect.assertions(1);

		const roots = resolve([
			projectConfig("/repo", ["out"]),
			projectConfig("/repo/packages/ui", ["build/luau"]),
		]);

		expect(roots).toStrictEqual([
			toPosixRoot(STAGING_DIRECTORY),
			rootAt("/repo", "out"),
			rootAt("/repo/packages/ui", "build/luau"),
		]);
	});

	it("should read one directory once however many projects name it", () => {
		expect.assertions(1);

		const roots = resolve([projectConfig("/repo", ["out"]), projectConfig("/repo", ["out/"])]);

		expect(roots).toStrictEqual([toPosixRoot(STAGING_DIRECTORY), rootAt("/repo", "out")]);
	});

	it("should contribute nothing for a project whose roots cannot be found", () => {
		expect.assertions(1);

		// No `luauRoots`, no rojo project to read mounts off, and no tsconfig
		// `outDir` — a run that still works, so it must not be refused here.
		expect(resolve([projectConfig("/repo")])).toStrictEqual([toPosixRoot(STAGING_DIRECTORY)]);
	});

	// The gate lives here rather than in each dispatch mode, so neither mode can
	// decide on its own that a backend may be served a harness.
	it("should split nothing for a backend that opens the place itself", () => {
		expect.assertions(1);

		expect(
			resolve([projectConfig("/repo", ["out"])], { backendKind: "studio" }),
		).toBeUndefined();
	});

	it("should split nothing for a run that turned the binary input off", () => {
		expect.assertions(1);

		expect(resolve([projectConfig("/repo", ["out"])], { binaryInput: false })).toBeUndefined();
	});
});
