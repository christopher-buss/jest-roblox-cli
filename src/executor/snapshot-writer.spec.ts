import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { writeSnapshots } from "./snapshot-writer.ts";

const ROOT = path.resolve("/repo");

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny<ResolvedConfig, unknown>({
		...createResolvedConfig(),
		rojoProject: path.join(ROOT, "default.project.json"),
		rootDir: ROOT,
		silent: true,
		...overrides,
	});
}

function seedProject(fileSystem: FileSystem, fileName = "default.project.json"): void {
	fileSystem.mkdirSync(ROOT, { recursive: true });
	fileSystem.writeFileSync(
		path.join(ROOT, fileName),
		JSON.stringify({
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		}),
	);
}

describe(writeSnapshots, () => {
	it("should write a mapped snapshot to both source and output directories", () => {
		expect.assertions(3);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem);

		const counts = writeSnapshots({
			config: config(),
			fileSystem,
			snapshotWrites: { "ReplicatedStorage/Button.spec.snap.luau": "snapshot body" },
			tsconfigMappings: [{ outDir: "out", rootDir: "src" }],
		});

		expect(counts).toBe(0);

		expect(
			fileSystem.readFileSync(path.join(ROOT, "src/shared/Button.spec.snap.luau"), "utf-8"),
		).toBe("snapshot body");
		expect(
			fileSystem.readFileSync(path.join(ROOT, "out/shared/Button.spec.snap.luau"), "utf-8"),
		).toBe("snapshot body");
	});

	it("should count unresolved paths as failures and report partial success", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const counts = writeSnapshots({
			config: config({ silent: false }),
			fileSystem,
			snapshotWrites: {
				"ReplicatedStorage/valid.snap.luau": "valid",
				"Workspace/missing.snap.luau": "missing",
			},
			tsconfigMappings: [],
		});

		expect(counts).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Wrote 1 of 2 snapshot files\n");
	});

	it("should use singular and plural success summaries", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		writeSnapshots({
			config: config({ silent: false }),
			fileSystem,
			snapshotWrites: { "ReplicatedStorage/one.snap.luau": "one" },
			tsconfigMappings: [],
		});

		expect(stderr).toHaveBeenLastCalledWith("Wrote 1 snapshot file\n");

		writeSnapshots({
			config: config({ silent: false }),
			fileSystem,
			snapshotWrites: {
				"ReplicatedStorage/one.snap.luau": "one",
				"ReplicatedStorage/two.snap.luau": "two",
			},
			tsconfigMappings: [],
		});

		expect(stderr).toHaveBeenLastCalledWith("Wrote 2 snapshot files\n");
	});

	it("should fail the entire batch when the configured project is missing", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		fileSystem.mkdirSync(ROOT, { recursive: true });

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots({
				config: config({ rojoProject: path.join(ROOT, "missing.project.json") }),
				fileSystem,
				snapshotWrites: { "ReplicatedStorage/one.snap.luau": "one" },
				tsconfigMappings: [],
			}),
		).toBe(1);
		expect(stderr).toHaveBeenCalledWith(
			"Warning: Cannot write snapshots - no rojo project found\n",
		);
	});

	it("should not print a success summary when every path is unresolved", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots({
				config: config({ silent: false }),
				fileSystem,
				snapshotWrites: { "Workspace/missing.snap.luau": "missing" },
				tsconfigMappings: [],
			}),
		).toBe(1);
		expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/^Wrote /));
	});

	it("should report malformed project JSON with its source path", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		fileSystem.mkdirSync(ROOT, { recursive: true });

		const projectPath = path.join(ROOT, "default.project.json");
		fileSystem.writeFileSync(projectPath, "not json");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots({
				config: config(),
				fileSystem,
				snapshotWrites: { "ReplicatedStorage/one.snap.luau": "one" },
				tsconfigMappings: [],
			}),
		).toBe(1);

		const warning = String(stderr.mock.calls[0]![0]);

		expect(stripVTControlCharacters(warning)).toContain(`File: ${projectPath}`);
	});

	it("should count a filesystem write error as a failed snapshot", () => {
		expect.assertions(2);

		const { fileSystem } = createMemoryFileSystem();

		seedProject(fileSystem);

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(fileSystem, "writeFileSync").mockImplementation(() => {
			throw new Error("disk full");
		});

		expect(
			writeSnapshots({
				config: config(),
				fileSystem,
				snapshotWrites: { "ReplicatedStorage/one.snap.luau": "one" },
				tsconfigMappings: [],
			}),
		).toBe(1);
		expect(stderr).toHaveBeenCalledWith(
			"Warning: Failed to write snapshot ReplicatedStorage/one.snap.luau: Error: disk full\n",
		);
	});
});
