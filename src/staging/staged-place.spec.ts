import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { writingRojoExec } from "#test/mocks/rojo-exec.ts";
import { recordingTimingCollector } from "#test/mocks/workspace-timing-recorder.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { buildStagedPlaceAsync } from "./staged-place.ts";

const CACHE = path.resolve("/c");
const PACKAGE_PROJECT = path.resolve("/pkg/default.project.json");
const PLACE_FILE = path.join(CACHE, "place.rbxl");

type ExecCallback = (cause: Error | null, stdout: string, stderr: string) => void;
type RojoExec = (
	file: string,
	args: Array<string>,
	options: object,
	callback: ExecCallback,
) => void;

function seed() {
	const memory = createMemoryFileSystem({
		[PACKAGE_PROJECT]: JSON.stringify({ name: "pkg", tree: { $className: "DataModel" } }),
	});
	const execFile = vi.fn<RojoExec>(
		writingRojoExec({ bytes: "place", fileSystem: memory.volume }),
	);
	const childProcess: ChildProcessRunner = fromAny({ execFile });
	return { ...memory, childProcess, execFile };
}

async function buildAsync(harness: ReturnType<typeof seed>) {
	const { collector, paths } = recordingTimingCollector();
	const built = await buildStagedPlaceAsync({
		cacheDirectory: CACHE,
		childProcess: harness.childProcess,
		fileSystem: harness.fileSystem,
		packages: [{ rojoProjectPath: PACKAGE_PROJECT }],
		placeFile: PLACE_FILE,
		progress: NOOP_PROGRESS,
		timing: collector,
		wrap: false,
	});
	return { built, paths };
}

describe(buildStagedPlaceAsync, () => {
	it("should build the place under the rojoBuild span", async () => {
		expect.assertions(3);

		const harness = seed();
		const { built, paths } = await buildAsync(harness);

		expect(built.artifact.path).toBe(PLACE_FILE);
		expect(paths).toStrictEqual(["rojoBuild"]);
		expect(harness.volume.existsSync(path.join(CACHE, "synthesized.project.json"))).toBeTrue();
	});

	it("should reuse the place when its inputs are unchanged", async () => {
		expect.assertions(3);

		const harness = seed();
		const first = await buildAsync(harness);
		const second = await buildAsync(harness);

		expect(first.built.rebuilt).toBeTrue();
		expect(second.built.rebuilt).toBeFalse();
		expect(second.built.artifact).toStrictEqual(first.built.artifact);
	});
});
