import { fromAny } from "@total-typescript/shoehorn";

import { vol } from "memfs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import { readPnpmWorkspaceProjects } from "./pnpm-workspace-state.ts";

vi.mock(import("node:fs"), async () => {
	const memfs = await vi.importActual<typeof import("memfs")>("memfs");
	return fromAny({ ...memfs.fs, default: memfs.fs });
});

const ROOT = path.resolve("/repo");
const FOO = path.join(ROOT, "packages/foo");
const STATE_PATH = path.join(ROOT, "node_modules/.pnpm-workspace-state-v1.json");
const YAML_PATH = path.join(ROOT, "pnpm-workspace.yaml");

const INSTALLED_AT = Date.UTC(2026, 0, 2);
const BEFORE_INSTALL = new Date(Date.UTC(2026, 0, 1));
const AFTER_INSTALL = new Date(Date.UTC(2026, 0, 3));

/**
 * Lay down a workspace whose `pnpm-workspace.yaml` predates the recorded
 * install, so every guard but the one under test passes.
 */
function writeWorkspace(
	state: Record<string, unknown> | string,
	yamlModifiedAt: Date = BEFORE_INSTALL,
): void {
	vol.reset();
	vol.fromJSON({
		[STATE_PATH]: typeof state === "string" ? state : JSON.stringify(state),
		[YAML_PATH]: "packages:\n  - packages/*\n",
	});
	vol.utimesSync(YAML_PATH, yamlModifiedAt, yamlModifiedAt);
}

function stateWith(projects: Record<string, unknown>): Record<string, unknown> {
	return { lastValidatedTimestamp: INSTALLED_AT, projects };
}

describe(readPnpmWorkspaceProjects, () => {
	it("should read every project pnpm recorded, root included", () => {
		expect.assertions(1);

		writeWorkspace(
			stateWith({
				[FOO]: { name: "@halcyon/foo", version: "1.0.0" },
				[ROOT]: { name: "halcyon", version: "0.0.0" },
			}),
		);

		expect(readPnpmWorkspaceProjects(ROOT)).toIncludeSameMembers([
			{ name: "halcyon", packageDirectory: ROOT },
			{ name: "@halcyon/foo", packageDirectory: FOO },
		]);
	});

	it("should tolerate the top-level fields pnpm adds between versions", () => {
		expect.assertions(1);

		writeWorkspace({
			configDependencies: {},
			filteredInstall: false,
			lastValidatedTimestamp: INSTALLED_AT,
			pnpmfiles: ["/somewhere/pnpmfile.mjs"],
			projects: { [ROOT]: { name: "halcyon", version: "0.0.0" } },
			settings: { autoInstallPeers: true },
		});

		expect(readPnpmWorkspaceProjects(ROOT)).toStrictEqual([
			{ name: "halcyon", packageDirectory: ROOT },
		]);
	});

	it("should return undefined when no state file exists", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [YAML_PATH]: "packages:\n  - packages/*\n" });

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should return undefined when the state file is not valid JSON", () => {
		expect.assertions(1);

		writeWorkspace("{ not valid json");

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should return undefined when the state file does not match the shape we read", () => {
		expect.assertions(1);

		writeWorkspace({ lastValidatedTimestamp: INSTALLED_AT, projects: [] });

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should return undefined when the state file has no validation timestamp", () => {
		expect.assertions(1);

		writeWorkspace({ projects: { [ROOT]: { name: "halcyon" } } });

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should return undefined when pnpm-workspace.yaml changed after the install", () => {
		expect.assertions(1);

		writeWorkspace(stateWith({ [ROOT]: { name: "halcyon" } }), AFTER_INSTALL);

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should accept a pnpm-workspace.yaml written in the same millisecond as the install", () => {
		expect.assertions(1);

		writeWorkspace(stateWith({ [ROOT]: { name: "halcyon" } }), new Date(INSTALLED_AT));

		expect(readPnpmWorkspaceProjects(ROOT)).toStrictEqual([
			{ name: "halcyon", packageDirectory: ROOT },
		]);
	});

	it("should return undefined when pnpm-workspace.yaml is missing", () => {
		expect.assertions(1);

		vol.reset();
		vol.fromJSON({ [STATE_PATH]: JSON.stringify(stateWith({ [ROOT]: { name: "halcyon" } })) });

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	// A `node_modules` carried between platforms records paths this host reads
	// as relative. Rooted at cwd so the relative path resolves *inside* the
	// workspace: the containment check would pass it, and only the
	// absoluteness check stands between the run and a directory nobody named.
	it("should return undefined when a recorded project path is not absolute here", () => {
		expect.assertions(1);

		const cwdRoot = process.cwd();
		vol.reset();
		vol.fromJSON({
			[path.join(cwdRoot, "node_modules/.pnpm-workspace-state-v1.json")]: JSON.stringify(
				stateWith({ "packages/foo": { name: "@halcyon/foo" } }),
			),
			[path.join(cwdRoot, "pnpm-workspace.yaml")]: "packages:\n  - packages/*\n",
		});
		vol.utimesSync(path.join(cwdRoot, "pnpm-workspace.yaml"), BEFORE_INSTALL, BEFORE_INSTALL);

		expect(readPnpmWorkspaceProjects(cwdRoot)).toBeUndefined();
	});

	it("should return undefined when a recorded project sits outside the workspace root", () => {
		expect.assertions(1);

		writeWorkspace(
			stateWith({
				[path.resolve("/elsewhere/packages/foo")]: { name: "@halcyon/foo" },
				[ROOT]: { name: "halcyon" },
			}),
		);

		expect(readPnpmWorkspaceProjects(ROOT)).toBeUndefined();
	});

	it("should skip a project pnpm recorded without a name", () => {
		expect.assertions(1);

		writeWorkspace(
			stateWith({
				[path.join(ROOT, "packages/anon")]: { version: "1.0.0" },
				[ROOT]: { name: "halcyon" },
			}),
		);

		expect(readPnpmWorkspaceProjects(ROOT)).toStrictEqual([
			{ name: "halcyon", packageDirectory: ROOT },
		]);
	});
});
