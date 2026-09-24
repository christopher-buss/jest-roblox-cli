import { PLACE_MISMATCH } from "@isentinel/roblox-runner/testing";

import * as fs from "node:fs";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { CODE_BUNDLE_REBUILD_SOURCE } from "../../../src/luau/code-bundle-rebuild.ts";
import {
	isTaskCreatePost,
	startFakeOpenCloudServerAsync,
	TASK_CREATE_SUFFIX,
} from "./fake-open-cloud.ts";
import {
	buildMixedOutput,
	buildPassingPayload,
	createOpenCloudEnvironment,
	createRbxtsFixtureSandbox,
	rojoOnPath,
	runCliAsync,
} from "./helpers.ts";
import { descendants, readPlaceTree } from "./place-tree.ts";

const RBXTS_FIXTURE = path.resolve(__dirname, "../fixtures/rbxts-project");
const PLACE_FILE = "game.rbxlx";

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

const EXACT_VERSION_TASKS = `/places/456/versions/1${TASK_CREATE_SUFFIX}`;

describe.skipIf(!rojoOnPath())("an ordinary Open Cloud run on a Shared Place", () => {
	it("should upload one complete place and pin the probe and the tests to its version", async () => {
		expect.assertions(8);

		const sandbox = createRbxtsFixtureSandbox(RBXTS_FIXTURE);
		fs.writeFileSync(path.join(sandbox, "jest.config.ts"), XML_PLACE_CONFIG);
		const server = await startFakeOpenCloudServerAsync([
			{ jestOutput: buildMixedOutput(buildPassingPayload()) },
		]);

		const result = await runCliAsync([], {
			cwd: sandbox,
			env: createOpenCloudEnvironment(server.baseUrl),
		});

		expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
		expect(server.uploadCount).toBe(1);

		// The run's code went inside the place. Addressed by tree rather than
		// by a byte scan: the place's own services serialize after the mount
		// does, so a substring search would read anything in them as staged.
		const placeNames = descendants(readPlaceTree(path.join(sandbox, PLACE_FILE))).map(
			(node) => node.name,
		);

		expect(placeNames).toContain("example.spec");

		// The probe and the one test task, in that order, both against the
		// version the upload returned — never head.
		const taskPosts = server.calls.filter(isTaskCreatePost);

		expect(taskPosts.map((call) => call.url)).toStrictEqual([
			expect.stringContaining(EXACT_VERSION_TASKS),
			expect.stringContaining(EXACT_VERSION_TASKS),
		]);

		// Nothing traveled beside the place.
		expect(server.binaryInputs).toStrictEqual([]);

		const submit = server.requests[0];
		assert(submit !== undefined, "expected the run to submit a test task");

		expect(submit.binaryInput).toBeUndefined();
		expect(submit.script).not.toContain(CODE_BUNDLE_REBUILD_SOURCE);
		// A task pinned to its version has no other version to refuse.
		expect(submit.script).not.toContain(PLACE_MISMATCH);
	});
});
