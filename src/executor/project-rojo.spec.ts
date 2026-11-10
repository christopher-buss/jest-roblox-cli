import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import { readProjectRojo } from "./project-rojo.ts";

const ROOT = path.resolve("/repo");

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny<ResolvedConfig, unknown>({
		...createResolvedConfig(),
		rootDir: ROOT,
		...overrides,
	});
}

describe(readProjectRojo, () => {
	it("should answer missing when the config has no project", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		fileSystem.mkdirSync(ROOT, { recursive: true });

		expect(readProjectRojo(config(), fileSystem)).toStrictEqual({ kind: "missing" });
	});

	it("should answer missing when the configured project is absent", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		fileSystem.mkdirSync(ROOT, { recursive: true });

		expect(
			readProjectRojo(
				config({ rojoProject: path.join(ROOT, "gone.project.json") }),
				fileSystem,
			),
		).toStrictEqual({ kind: "missing" });
	});

	it("should load the project with its directory", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		const directory = path.join(ROOT, "rojo");
		fileSystem.mkdirSync(directory, { recursive: true });
		fileSystem.writeFileSync(
			path.join(directory, "game.project.json"),
			JSON.stringify({ name: "game", tree: { $path: "src" } }),
		);

		expect(
			readProjectRojo(
				config({ rojoProject: path.join(directory, "game.project.json") }),
				fileSystem,
			),
		).toMatchObject({
			kind: "loaded",
			project: { name: "game", tree: { $path: "src" } },
			rojoDirectory: directory,
		});
	});

	it("should hold the failure of a malformed project with its path", () => {
		expect.assertions(1);

		const { fileSystem } = createMemoryFileSystem();
		fileSystem.mkdirSync(ROOT, { recursive: true });
		fileSystem.writeFileSync(path.join(ROOT, "default.project.json"), "{");

		expect(
			readProjectRojo(
				config({ rojoProject: path.join(ROOT, "default.project.json") }),
				fileSystem,
			),
		).toStrictEqual({
			error: expect.objectContaining({ message: expect.stringMatching(/Failed to parse/) }),
			kind: "failed",
			projectPath: path.join(ROOT, "default.project.json"),
		});
	});
});
