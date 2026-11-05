import type { BinaryInputUploader } from "@isentinel/roblox-runner";

import process from "node:process";
import type { Except } from "type-fest";

import { ConfigError } from "../config/errors.ts";
import type { RunProgress } from "../progress/reporter.ts";
import { describeCodeBundle } from "../progress/stages.ts";
import type { CodeBundleArtifact } from "../staging/code-bundle.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { rethrowBinaryInputFailure } from "./open-cloud-failures.ts";

const BINARY_INPUT_LIFETIME_MS = 15 * 60_000;

interface BundleInput {
	createdAt: number;
	path: string;
}

interface BundleRunOptions {
	artifact: CodeBundleArtifact;
	fileSystem: FileSystem;
	now: () => number;
	progress: RunProgress;
	runner: BinaryInputUploader;
}

/**
 * The Code Bundle this run ships, and the input it has been uploaded as.
 *
 * One per run, held on the backend rather than threaded through every dispatch
 * shape: the input is created once and then named by every submit, several of
 * them layers below the call that made it.
 */
export class BundleRun {
	private readonly options: BundleRunOptions;

	/**
	 * Absent until the bundle has been uploaded, which is after the boot
	 * probe.
	 */
	private input: BundleInput | undefined;
	/**
	 * The upload in flight, so submits that all cross the refresh threshold at
	 * once wait on one create rather than each making its own — N creates
	 * against a five-a-minute quota, N PUTs of the same tens of megabytes, and
	 * N stage lines for one upload.
	 */
	private pending: Promise<BundleInput> | undefined;

	/** Create and PUT time, this run's refreshes included. */
	public uploadMs = 0;

	/**
	 * Hold the options; nothing uploads until the first ask.
	 *
	 * @param options - Artifact, runner, clock, file system, and progress sink.
	 */
	constructor(options: BundleRunOptions) {
		this.options = options;
	}

	/**
	 * The input every submit names.
	 *
	 * Uploaded on the first ask and created again once the one in hand is too
	 * old to survive the next task. Asked before every submit rather than once
	 * per run, because an input is Open Cloud's to expire and a long run
	 * outlives one: a late shard would otherwise fail on an input that was
	 * valid when the run started.
	 *
	 * @param minimumValidityMs - Time the input must stay valid for, in
	 *   milliseconds.
	 * @returns The binary input path.
	 * @rejects {@link ConfigError} When the upload fails, or finishes too late
	 *   to stay valid.
	 */
	public async ensureInputAsync(minimumValidityMs: number): Promise<string> {
		const { now } = this.options;
		const { input } = this;
		if (
			input !== undefined &&
			now() - input.createdAt < BINARY_INPUT_LIFETIME_MS - minimumValidityMs
		) {
			return input.path;
		}

		this.pending ??= this.uploadAsync().finally(() => {
			// Cleared on settle rather than kept: the next ask past the
			// threshold has to make a real create, and a rejected one must not
			// be handed to every later submit as the answer.
			this.pending = undefined;
		});
		const uploaded = await this.pending;
		if (now() - uploaded.createdAt >= BINARY_INPUT_LIFETIME_MS - minimumValidityMs) {
			throw new ConfigError(
				"The binary input upload completed too late to remain valid through task admission and boot.",
				"Upload the code inside the place instead.",
			);
		}

		return uploaded.path;
	}

	/**
	 * Send the Code Bundle and record the input it became.
	 *
	 * The runner reports what the upload cost and that figure is the one the
	 * run carries: it spans the create and the PUT, the pacer's wait for the
	 * per-key quota included, which is exactly the slice this backend would
	 * otherwise be re-measuring around it. A refresh adds onto the same number.
	 *
	 * @returns The new input and its create time.
	 * @rejects {@link ConfigError} When the upload fails.
	 */
	private async uploadAsync(): Promise<BundleInput> {
		const { artifact, fileSystem, now, progress, runner } = this.options;
		const done = progress.begin("bundle", describeCodeBundle(artifact));
		// Read before the create, and the only clock this keeps: Open Cloud's
		// fifteen minutes run from the create, so dating the input at the end
		// of the upload would read it as younger than Roblox does.
		const createdAt = now();
		const created = await runner
			.uploadBinaryInputAsync({ payload: fileSystem.readFileSync(artifact.path) })
			.catch(rethrowBinaryInputFailure);
		done();
		this.uploadMs += created.uploadMs;
		this.input = { createdAt, path: created.path };
		return this.input;
	}
}

/**
 * This run's bundle state, before anything has been uploaded, after naming the
 * Code Mounts that could not travel.
 *
 * A mount that stayed is a finding rather than a fault — the place still
 * serves it and the run is correct either way — so it is said where the split
 * result reaches the backend, and never raised.
 *
 * @param options - Bundle run options; the artifact is undefined when the run
 *   ships no bundle.
 * @returns The bundle run, or undefined when there is no artifact.
 */
export function openBundleRun(
	options: Except<BundleRunOptions, "artifact"> & { artifact: CodeBundleArtifact | undefined },
): BundleRun | undefined {
	const { artifact } = options;
	const stayedMounts = artifact?.stayedMounts ?? [];
	if (stayedMounts.length > 0) {
		process.stderr.write(
			`Note: ${String(stayedMounts.length)} code mount(s) stayed in the place, ` +
				`each holding a file a task cannot rebuild:\n${stayedMounts
					.map((mount) => `  ${mount}\n`)
					.join("")}`,
		);
	}

	return artifact === undefined ? undefined : new BundleRun({ ...options, artifact });
}
