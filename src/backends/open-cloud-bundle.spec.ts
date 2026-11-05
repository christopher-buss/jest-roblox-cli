import type {
	BinaryInputUploader,
	UploadBinaryInputOptions,
	UploadBinaryInputResult,
} from "@isentinel/roblox-runner";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { NOOP_PROGRESS } from "#test/mocks/noop-progress.ts";
import { captureStderrForTest as captureStderr } from "#test/mocks/spec-open-cloud.ts";
import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import { BundleRun, openBundleRun } from "./open-cloud-bundle.ts";

const BUNDLE_FILE = "/cache/code-bundle.json";
const BUNDLE_JSON = '{"mounts":[],"version":1}';
const FIRST_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-1";
const REFRESHED_PATH = "universes/123/luau-execution-session-task-binary-inputs/input-2";
const VALIDITY_MS = 60_000;
const REFRESH_AT_MS = 14 * 60_000;

function artifact(stayedMounts: Array<string> = []): CodeBundleArtifact {
	return { byteLength: BUNDLE_JSON.length, fileCount: 3, path: BUNDLE_FILE, stayedMounts };
}

function setup({ stayedMounts }: { stayedMounts?: Array<string> } = {}) {
	const clock = { now: 0 };
	const { fileSystem } = createMemoryFileSystem({ [BUNDLE_FILE]: BUNDLE_JSON });
	let uploads = 0;
	const uploadBinaryInputAsync = vi.fn<
		(options: UploadBinaryInputOptions) => Promise<UploadBinaryInputResult>
	>(async () => {
		uploads += 1;
		return { path: uploads === 1 ? FIRST_PATH : REFRESHED_PATH, uploadMs: 7 };
	});
	const bundle = openBundleRun({
		artifact: artifact(stayedMounts),
		fileSystem,
		now: () => clock.now,
		progress: NOOP_PROGRESS,
		runner: { uploadBinaryInputAsync },
	});
	if (bundle === undefined) {
		throw new Error("expected a bundle run");
	}

	return { bundle, clock, uploadBinaryInputAsync };
}

describe(openBundleRun, () => {
	it("should hold no bundle for a run that ships the whole place", () => {
		expect.assertions(2);

		const writes = captureStderr();
		const { fileSystem } = createMemoryFileSystem();

		expect(
			openBundleRun({
				artifact: undefined,
				fileSystem,
				now: Date.now,
				progress: NOOP_PROGRESS,
				runner: {
					uploadBinaryInputAsync: vi.fn<BinaryInputUploader["uploadBinaryInputAsync"]>(),
				},
			}),
		).toBeUndefined();
		expect(writes).toStrictEqual([]);
	});

	it("should name the mounts that stayed once, on stderr", () => {
		expect.assertions(1);

		const writes = captureStderr();
		setup({
			stayedMounts: [
				"ServerStorage/__pkg_stage/pkg/assets",
				"ReplicatedStorage/__pkg_stage/shared/config",
			],
		});

		expect(writes).toStrictEqual([
			"Note: 2 code mount(s) stayed in the place, each holding a file a task cannot rebuild:\n" +
				"  ServerStorage/__pkg_stage/pkg/assets\n" +
				"  ReplicatedStorage/__pkg_stage/shared/config\n",
		]);
	});

	it("should say nothing when every code mount travels", () => {
		expect.assertions(1);

		const writes = captureStderr();
		setup();

		expect(writes).toStrictEqual([]);
	});
});

describe(BundleRun, () => {
	it("should upload the bundle bytes once and add the runner's cost to uploadMs", async () => {
		expect.assertions(3);

		const { bundle, uploadBinaryInputAsync } = setup();
		await bundle.ensureInputAsync(VALIDITY_MS);

		await expect(bundle.ensureInputAsync(VALIDITY_MS)).resolves.toBe(FIRST_PATH);
		expect(Buffer.from(uploadBinaryInputAsync.mock.calls[0]![0].payload).toString()).toBe(
			BUNDLE_JSON,
		);
		expect(bundle.uploadMs).toBe(7);
	});

	it.for([
		{ elapsedMs: REFRESH_AT_MS, expected: REFRESHED_PATH, uploads: 2 },
		{ elapsedMs: REFRESH_AT_MS - 1, expected: FIRST_PATH, uploads: 1 },
	])(
		"should hand back $expected for an input $elapsedMs ms old",
		async ({ elapsedMs, expected, uploads }) => {
			expect.assertions(2);

			const { bundle, clock, uploadBinaryInputAsync } = setup();
			await bundle.ensureInputAsync(VALIDITY_MS);
			clock.now = elapsedMs;

			await expect(bundle.ensureInputAsync(VALIDITY_MS)).resolves.toBe(expected);
			expect(uploadBinaryInputAsync).toHaveBeenCalledTimes(uploads);
		},
	);

	/**
	 * Every submit of a sharded run crosses the refresh threshold at the same
	 * moment, so without a hold on the upload in flight each one fires its own
	 * create — N against a five-a-minute quota, N PUTs of the same bytes.
	 */
	it("should make one create for concurrent asks that all want a fresh input", async () => {
		expect.assertions(2);

		const { bundle, uploadBinaryInputAsync } = setup();

		await expect(
			Promise.all([
				bundle.ensureInputAsync(VALIDITY_MS),
				bundle.ensureInputAsync(VALIDITY_MS),
			]),
		).resolves.toStrictEqual([FIRST_PATH, FIRST_PATH]);
		expect(uploadBinaryInputAsync).toHaveBeenCalledOnce();
	});

	it("should reject an input whose upload consumed its validity margin", async () => {
		expect.assertions(1);

		const { bundle, clock, uploadBinaryInputAsync } = setup();
		uploadBinaryInputAsync.mockImplementationOnce(async () => {
			clock.now = REFRESH_AT_MS;
			return { path: FIRST_PATH, uploadMs: 7 };
		});

		await expect(bundle.ensureInputAsync(VALIDITY_MS)).rejects.toMatchObject({
			hint: "Upload the code inside the place instead.",
			message:
				"The binary input upload completed too late to remain valid through task admission and boot.",
		});
	});

	it("should name the quota when the create cannot complete", async () => {
		expect.assertions(1);

		const { bundle, uploadBinaryInputAsync } = setup();
		uploadBinaryInputAsync.mockRejectedValueOnce(new Error("slot: 429"));

		await expect(bundle.ensureInputAsync(VALIDITY_MS)).rejects.toThrow(
			"The run's code could not be sent to Open Cloud as a binary input: slot: 429",
		);
	});
});
