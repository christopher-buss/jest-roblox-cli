/**
 * E2e — a workspace run shipping its code as a binary input.
 *
 * Workspace staging names each package's stage node after the package, so a
 * scoped one is an instance whose name holds a slash. The Code Bundle joined a
 * mount's DataModel path on `/` and the in-session rebuild split it back,
 * turning that one node into `@e2e` -> `vendored-mount`; the materializer then
 * cloned from the node the project actually named, which the rebuild never
 * touched, and every scoped package failed its task before Jest ran.
 *
 * Driven through the fake Open Cloud server, which serves the presigned PUT
 * itself, so the bytes the run ships are what this reads back.
 */
import { type } from "arktype";
import * as path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { CODE_BUNDLE_REBUILD_SOURCE } from "../../../src/luau/code-bundle-rebuild.ts";
import { startFakeOpenCloudServerAsync } from "../cli/fake-open-cloud.ts";
import {
	buildPassingJestOutput,
	createFixtureSandbox,
	createOpenCloudEnvironment,
	rojoOnPath,
	runCliAsync,
} from "../cli/helpers.ts";

const WORKSPACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/workspace");

const bundleSchema = type({
	mounts: type({ dataModelPath: "string[]" }).array(),
	version: "number",
});

describe("workspace binary input for a scoped package", () => {
	it.skipIf(!rojoOnPath())(
		"should carry the scoped stage name as one segment and dispatch the package",
		async () => {
			expect.assertions(5);

			const sandbox = createFixtureSandbox(WORKSPACE_FIXTURE_PATH);

			const server = await startFakeOpenCloudServerAsync([
				{
					jestOutput: buildPassingJestOutput(),
					pkg: "@e2e/vendored-mount",
					project: "@e2e/vendored-mount",
				},
			]);

			const result = await runCliAsync(
				["--workspace", "--packages=@e2e/vendored-mount", "--backend", "open-cloud"],
				{
					cwd: sandbox,
					env: createOpenCloudEnvironment(server.baseUrl),
					timeoutMs: 60_000,
				},
			);

			expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
			// The package reached the backend rather than the run
			// short-circuiting.
			expect(server.requests[0]!.script).toContain('"pkg":"@e2e/vendored-mount"');
			// The rebuild rides the same script the materializer runs, so the
			// stage it clones has been rebuilt by the time it looks.
			expect(server.requests[0]!.script).toContain(CODE_BUNDLE_REBUILD_SOURCE);

			const binaryInput = server.binaryInputs[0];
			assert(binaryInput !== undefined, "expected the run to allocate a binary input");
			const { body } = binaryInput;
			assert(body !== undefined, "expected the bundle bytes to reach the presigned PUT");
			const bundle = bundleSchema.assert(JSON.parse(body));

			// One segment per instance: the scoped name is a name, not a path.
			expect(bundle.mounts.map((mount) => mount.dataModelPath)).toContainEqual([
				"ServerStorage",
				"__pkg_stage",
				"@e2e/vendored-mount",
				"ReplicatedStorage",
				"Src",
			]);
			// Joined on `/`, `@e2e` was a segment of its own and the stage the
			// materializer clones was empty.
			expect(
				bundle.mounts.every((mount) => !mount.dataModelPath.includes("@e2e")),
			).toBeTrue();
		},
		60_000,
	);
});
