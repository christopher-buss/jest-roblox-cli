import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { MANIFEST_VERSION } from "../coverage-pipeline/manifest.ts";
import { computePlaceInputsKeyAsync } from "./place-reuse.ts";

/**
 * A mount with a few real files on a real disk. Real because the property
 * under test is that the fingerprint reaches the event loop at all, and an
 * in-memory filesystem can answer a read without ever going near it.
 */
function stageInputs(): { projectFile: string; projectJson: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "place-reuse-loop-"));
	onTestFinished(() => {
		fs.rmSync(root, { force: true, recursive: true });
	});

	const mount = path.join(root, "src");
	fs.mkdirSync(mount);
	for (const name of ["a", "b", "c"]) {
		fs.writeFileSync(path.join(mount, `${name}.luau`), `return "${name}"\n`);
	}

	const projectFile = path.join(root, "synthesized.project.json");
	const projectJson = JSON.stringify({
		name: "synthesized",
		tree: { $className: "DataModel", ReplicatedStorage: { $path: "src" } },
	});
	fs.writeFileSync(projectFile, projectJson);
	return { projectFile, projectJson };
}

describe(computePlaceInputsKeyAsync, () => {
	it("should reach the event loop while it fingerprints the build inputs", async () => {
		expect.assertions(2);

		const { projectFile, projectJson } = stageInputs();
		// A timer is the sharpest probe available: its callback cannot run
		// across an awaited synchronous call, however long that call takes, and
		// runs across the first real read once the walk is asynchronous.
		let wasEventLoopReached = false;
		setTimeout(() => {
			wasEventLoopReached = true;
		}, 0);

		const key = await computePlaceInputsKeyAsync({
			digestCacheFile: path.join(path.dirname(projectFile), "input-digests"),
			manifests: [],
			projectFile,
			projectJson,
			shadowRoots: [],
			stagingVersion: MANIFEST_VERSION,
		});

		expect(key).toBeTypeOf("string");
		// The stage block repaints from a timer of its own. A fingerprint that
		// never yields freezes that block on the duration it opened with, which
		// is what a `build` row reading `0ms` for its whole life was.
		expect(wasEventLoopReached).toBeTrue();
	});
});
