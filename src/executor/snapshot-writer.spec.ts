import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import type { ResolvedConfig } from "../config/schema.ts";
import { DEFAULT_CONFIG } from "../config/schema.ts";
import { findRojoProject, writeSnapshots } from "./snapshot-writer.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return fromAny<ResolvedConfig, unknown>({
		...DEFAULT_CONFIG,
		rootDir: ROOT,
		silent: true,
		...overrides,
	});
}

function seedProject(fileName = "default.project.json"): void {
	fs.mkdirSync(ROOT, { recursive: true });
	fs.writeFileSync(
		path.join(ROOT, fileName),
		JSON.stringify({
			name: "test",
			tree: { ReplicatedStorage: { $path: "out/shared" } },
		}),
	);
}

describe(findRojoProject, () => {
	it("should prefer default.project.json over other project files", () => {
		expect.assertions(1);

		vol.reset();
		seedProject("custom.project.json");
		seedProject();

		expect(findRojoProject(ROOT)).toBe(path.join(ROOT, "default.project.json"));
	});

	it("should find an alternate project file but reject similar suffixes", () => {
		expect.assertions(1);

		vol.reset();
		fs.mkdirSync(ROOT, { recursive: true });
		fs.writeFileSync(path.join(ROOT, "ignored.project.json.bak"), "{}");
		seedProject("custom.project.json");

		expect(findRojoProject(ROOT)).toBe(path.join(ROOT, "custom.project.json"));
	});

	it("should return undefined when no project file exists", () => {
		expect.assertions(1);

		vol.reset();
		fs.mkdirSync(ROOT, { recursive: true });

		expect(findRojoProject(ROOT)).toBeUndefined();
	});
});

describe(writeSnapshots, () => {
	it("should write a mapped snapshot to both source and output directories", () => {
		expect.assertions(3);

		vol.reset();
		seedProject();

		const counts = writeSnapshots(
			{ "ReplicatedStorage/Button.spec.snap.luau": "snapshot body" },
			config(),
			[{ outDir: "out", rootDir: "src" }],
		);

		expect(counts).toStrictEqual({ attempted: 1, failed: 0, written: 1 });
		expect(fs.readFileSync(path.join(ROOT, "src/shared/Button.spec.snap.luau"), "utf-8")).toBe(
			"snapshot body",
		);
		expect(fs.readFileSync(path.join(ROOT, "out/shared/Button.spec.snap.luau"), "utf-8")).toBe(
			"snapshot body",
		);
	});

	it("should count unresolved paths as failures and report partial success", () => {
		expect.assertions(2);

		vol.reset();
		seedProject();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const counts = writeSnapshots(
			{
				"ReplicatedStorage/valid.snap.luau": "valid",
				"Workspace/missing.snap.luau": "missing",
			},
			config({ silent: false }),
			[],
		);

		expect(counts).toStrictEqual({ attempted: 2, failed: 1, written: 1 });
		expect(stderr).toHaveBeenCalledWith("Wrote 1 of 2 snapshot files\n");
	});

	it("should use singular and plural success summaries", () => {
		expect.assertions(2);

		vol.reset();
		seedProject();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		writeSnapshots({ "ReplicatedStorage/one.snap.luau": "one" }, config({ silent: false }), []);

		expect(stderr).toHaveBeenLastCalledWith("Wrote 1 snapshot file\n");

		writeSnapshots(
			{
				"ReplicatedStorage/one.snap.luau": "one",
				"ReplicatedStorage/two.snap.luau": "two",
			},
			config({ silent: false }),
			[],
		);

		expect(stderr).toHaveBeenLastCalledWith("Wrote 2 snapshot files\n");
	});

	it("should fail the entire batch when the configured project is missing", () => {
		expect.assertions(2);

		vol.reset();
		fs.mkdirSync(ROOT, { recursive: true });
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots(
				{ "ReplicatedStorage/one.snap.luau": "one" },
				config({ rojoProject: "missing.project.json" }),
				[],
			),
		).toStrictEqual({ attempted: 1, failed: 1, written: 0 });
		expect(stderr).toHaveBeenCalledWith(
			"Warning: Cannot write snapshots - no rojo project found\n",
		);
	});

	it("should not print a success summary when every path is unresolved", () => {
		expect.assertions(2);

		vol.reset();
		seedProject();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots(
				{ "Workspace/missing.snap.luau": "missing" },
				config({ silent: false }),
				[],
			),
		).toStrictEqual({ attempted: 1, failed: 1, written: 0 });
		expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/^Wrote /));
	});

	it("should report malformed project JSON with its source path", () => {
		expect.assertions(2);

		vol.reset();
		fs.mkdirSync(ROOT, { recursive: true });
		const projectPath = path.join(ROOT, "default.project.json");
		fs.writeFileSync(projectPath, "not json");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		expect(
			writeSnapshots({ "ReplicatedStorage/one.snap.luau": "one" }, config(), []),
		).toStrictEqual({ attempted: 1, failed: 1, written: 0 });

		const warning = String(stderr.mock.calls[0]![0]);

		expect(stripVTControlCharacters(warning)).toContain(`File: ${projectPath}`);
	});

	it("should count a filesystem write error as a failed snapshot", () => {
		expect.assertions(2);

		vol.reset();
		seedProject();
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
			throw new Error("disk full");
		});

		expect(
			writeSnapshots({ "ReplicatedStorage/one.snap.luau": "one" }, config(), []),
		).toStrictEqual({ attempted: 1, failed: 1, written: 0 });
		expect(stderr).toHaveBeenCalledWith(
			"Warning: Failed to write snapshot ReplicatedStorage/one.snap.luau: Error: disk full\n",
		);
	});
});
