import { placeIdentityGuardSource } from "@isentinel/roblox-runner";

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { CODE_BUNDLE_REBUILD_SOURCE } from "../../../src/luau/code-bundle-rebuild.ts";
import { startFakeOpenCloudServerAsync } from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	rojoOnPath,
	runCliAsync,
} from "./helpers.ts";
import { descendants, nodeAt, readPlaceTree } from "./place-tree.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");
const PLACE_FILE = "game.rbxlx";

/**
 * The fixture's own project, plus the ignores a roblox-ts project declares for
 * the files the compiler leaves beside its output. Rojo builds nothing from a
 * `.d.ts` or a source map, and a mount holding a file no task can construct is
 * one the split leaves in the place.
 */
const IGNORING_ROJO_PROJECT = JSON.stringify({
	name: "rbxts-e2e",
	globIgnorePaths: ["**/*.d.ts", "**/*.map"],
	tree: {
		$className: "DataModel",
		ReplicatedStorage: { $className: "ReplicatedStorage", shared: { $path: "out" } },
	},
});

/**
 * The fixture's config, aimed at an XML place. Rojo picks the format off the
 * extension, and only the XML one can be read back as a tree.
 */
const XML_PLACE_CONFIG = `import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	placeFile: "./${PLACE_FILE}",
	rojoProject: "default.project.json",
	test: {
		projects: [
			{
				test: {
					displayName: "rbxts-e2e",
					include: ["src/**/*.spec.ts"],
					outDir: "out",
				},
			},
		],
	},
});
`;

interface BinaryInputRun {
	dispatchedScript: string;
	/** Every instance name in the built place, however deep. */
	placeNames: Array<string>;
	/** The bundle the run PUT, or undefined when it sent none. */
	putBody: string | undefined;
	/** The names the built place hangs directly off `ReplicatedStorage`. */
	replicatedStorageNames: Array<string>;
	taskInput: string | undefined;
}

/** One CLI run against the fake server, with everything a case asserts on. */
async function runFixtureAsync(args: Array<string>): Promise<BinaryInputRun> {
	const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
	fs.writeFileSync(path.join(sandbox, "jest.config.ts"), XML_PLACE_CONFIG);
	fs.writeFileSync(path.join(sandbox, "default.project.json"), IGNORING_ROJO_PROJECT);
	const server = await startFakeOpenCloudServerAsync([
		{ jestOutput: buildMixedOutput(buildPassingPayload()) },
	]);

	const result = await runCliAsync(args, {
		cwd: sandbox,
		env: createOpenCloudEnvironment(server.baseUrl),
	});

	expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);

	const place = readPlaceTree(path.join(sandbox, PLACE_FILE));
	const submit = server.requests[0];
	assert(submit !== undefined, "expected the run to submit a task");

	return {
		dispatchedScript: submit.script,
		// Addressed by tree rather than by a byte scan: the place's own
		// services serialize after the mount does, so a substring search would
		// read anything in them as staged.
		placeNames: descendants(place).map((node) => node.name),
		putBody: server.binaryInputs[0]?.body,
		replicatedStorageNames: nodeAt(place, ["ReplicatedStorage"]).children.map((child) => {
			return child.name;
		}),
		taskInput: submit.binaryInput,
	};
}

describe.skipIf(!rojoOnPath())("a run that ships its code as a binary input", () => {
	it("should build a place holding no code and send the code beside it", async () => {
		expect.assertions(6);

		const run = await runFixtureAsync([]);

		// The whole mount went into the bundle, and the project declared no
		// children beside it, so the harness does not serve it at all.
		expect(run.replicatedStorageNames).not.toContain("shared");
		expect(run.placeNames).not.toContain("example.spec");
		expect(run.putBody).toContain("example.spec");
		expect(run.putBody).toContain("Compiled with @isentinel/roblox-ts");
		expect(run.taskInput).toBe(
			"universes/123/luau-execution-session-task-binary-inputs/input-1",
		);
	});

	it("should carry the rebuild below the version guard on the dispatched script", async () => {
		expect.assertions(3);

		const { dispatchedScript } = await runFixtureAsync([]);
		const guard = placeIdentityGuardSource({ placeVersion: 1 });

		expect(dispatchedScript).toContain(CODE_BUNDLE_REBUILD_SOURCE);
		// Below the guard, so a task refused for booting another place version
		// returns before it rebuilds anything.
		expect(dispatchedScript.indexOf(guard)).toBeLessThan(
			dispatchedScript.indexOf(CODE_BUNDLE_REBUILD_SOURCE),
		);
	});

	it("should build the whole place under --no-binary-input", async () => {
		expect.assertions(5);

		const run = await runFixtureAsync(["--no-binary-input"]);

		expect(run.placeNames).toContain("example.spec");
		expect(run.putBody).toBeUndefined();
		expect(run.taskInput).toBeUndefined();
		expect(run.dispatchedScript).not.toContain(CODE_BUNDLE_REBUILD_SOURCE);
	});
});
