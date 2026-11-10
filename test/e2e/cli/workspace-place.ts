import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assert, onTestFinished } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createOpenCloudEnvironment,
	RUN_TIMEOUT_MS,
	runCliAsync,
} from "#test/harness/helpers.ts";
import { createSandboxDirectory } from "#test/harness/sandbox-root.ts";

/** One package of a throwaway workspace. */
export interface WorkspacePackage {
	/** Package name, which is also its directory under `packages/`. */
	name: string;
	/** Fields beside `rojoProject` in the package's `jest.config.ts`. */
	config?: Record<string, unknown>;
	/** Files written under the package directory, keyed by relative path. */
	files: Record<string, string>;
	/** Children of the DataModel in the package's `test.project.json`. */
	tree: Record<string, unknown>;
}

export interface SynthesizedWorkspace {
	/** The rojo project the CLI synthesized for the run. */
	projectPath: string;
	/** Workspace root. */
	root: string;
}

/**
 * Write a workspace, run the CLI over it against the fake Open Cloud, and
 * report where the project it synthesized landed. Each package needs one spec
 * of its own mounted, or the run skips it before synthesis.
 * @param options - Packages, shared files, and extra CLI flags.
 * @returns The workspace root and the synthesized project.
 */
export async function synthesizeWorkspaceAsync({
	args = [],
	files = {},
	packages,
}: {
	args?: Array<string>;
	files?: Record<string, string>;
	packages: Array<WorkspacePackage>;
}): Promise<SynthesizedWorkspace> {
	const root = createSandboxDirectory();
	onTestFinished(() => {
		rmSync(root, { force: true, recursive: true });
	});

	writeWorkspace({ files, packages, root });

	const server = await startFakeOpenCloudServerAsync(
		packages.map(({ name }) => {
			return { jestOutput: buildPassingJestOutput(), pkg: name, project: name };
		}),
	);
	const result = await runCliAsync(
		[
			"--workspace",
			`--packages=${packages.map(({ name }) => name).join(",")}`,
			"--backend",
			"open-cloud",
			`--parallel=${packages.length.toString()}`,
			...args,
		],
		{ cwd: root, env: createOpenCloudEnvironment(server.baseUrl), timeoutMs: RUN_TIMEOUT_MS },
	);
	assert(result.exitCode === 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);

	return {
		projectPath: path.join(root, ".jest-roblox/workspace/synthesized.project.json"),
		root,
	};
}

/**
 * Build a rojo project into an `.rbxlx` beside it, with a real `rojo build`.
 * @param projectPath - The project the CLI synthesized.
 * @returns Where the `.rbxlx` landed.
 */
export function buildRbxlx(projectPath: string): string {
	const placeFile = path.join(path.dirname(projectPath), "place.rbxlx");
	execFileSync("rojo", ["build", projectPath, "-o", placeFile], {
		stdio: "pipe",
		windowsHide: true,
	});
	return placeFile;
}

function writeFiles(directory: string, files: Record<string, string>): void {
	for (const [relativePath, contents] of Object.entries(files)) {
		const filePath = path.join(directory, relativePath);
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, contents);
	}
}

function writeWorkspace({
	files,
	packages,
	root,
}: {
	files: Record<string, string>;
	packages: Array<WorkspacePackage>;
	root: string;
}): void {
	writeFiles(root, { ...files, "pnpm-workspace.yaml": "packages:\n  - packages/*\n" });
	for (const { name, config = {}, files: packageFiles, tree } of packages) {
		writeFiles(path.join(root, "packages", name), {
			...packageFiles,
			"jest.config.ts": `export default ${JSON.stringify({ rojoProject: "test.project.json", test: {}, ...config })};\n`,
			"package.json": JSON.stringify({
				name,
				private: true,
				type: "module",
				version: "0.0.0",
			}),
			"test.project.json": JSON.stringify({
				name: `${name}-test`,
				tree: { $className: "DataModel", ...tree },
			}),
		});
	}
}
