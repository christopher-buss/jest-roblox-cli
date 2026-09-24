import { resolveCredentials, type RunnerCredentials } from "@isentinel/roblox-runner";

import assert from "node:assert";

import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { getAffectedPackages } from "../workspace/affected.ts";
import {
	enumerateWorkspacePackages,
	type EnumerationOptions,
	excludePackages,
	type PackageInfo,
	resolvePackages,
} from "../workspace/package-resolver.ts";

/** {@link EnumerationOptions} plus what `--affected-since` launches. */
export interface WorkspacePackageSelection extends EnumerationOptions {
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
}

interface WorkspaceValidationOk {
	ok: true;
}

interface WorkspaceValidationError {
	exitCode: 2;
	message: string;
	ok: false;
}

type WorkspaceValidationResult = WorkspaceValidationError | WorkspaceValidationOk;

/**
 * The flags that mean nothing outside workspace mode, in the order the
 * "requires --workspace" error names them.
 *
 * One table, two readers: {@link isWorkspaceInvocation} routes a run carrying
 * any of them down the workspace path, and {@link validateBasicWorkspaceFlags}
 * names the one that got it there. Adding a flag to only one of those would
 * either ignore it silently or misname it in the error.
 */
const WORKSPACE_ONLY_FLAGS: ReadonlyArray<{
	isPresent: (cli: CliOptions) => boolean;
	name: string;
}> = [
	{ name: "--affected-since", isPresent: (cli) => cli.affectedSince !== undefined },
	{ name: "--packages", isPresent: (cli) => cli.packages !== undefined },
	{ name: "--bail", isPresent: (cli) => cli.bail === true },
];

/**
 * Whether this invocation belongs on the workspace path.
 *
 * `--workspace` says so outright; the workspace-only flags say so by being
 * present without it, which is what lets the validation below reject them by
 * name rather than leaving them silently inert on a single-package run.
 */
export function isWorkspaceInvocation(cli: CliOptions): boolean {
	return cli.workspace === true || WORKSPACE_ONLY_FLAGS.some((flag) => flag.isPresent(cli));
}

/**
 * Pure CLI-shape checks — runs before package resolution or config loading.
 * Catches mutually-exclusive flag combos and the missing --workspace.
 */
export function validateBasicWorkspaceFlags(cli: CliOptions): WorkspaceValidationResult {
	if (cli.packages !== undefined && cli.affectedSince !== undefined) {
		return {
			exitCode: 2,
			message: "Error: --packages and --affected-since are mutually exclusive.\n",
			ok: false,
		};
	}

	if (cli.workspace !== true) {
		return {
			exitCode: 2,
			message: `Error: ${namePresentWorkspaceFlag(cli)} requires --workspace.\n`,
			ok: false,
		};
	}

	// A bare `--workspace` means every package, so an empty `--packages` cannot
	// fall through to it: the user narrowed the run and then named nothing, and
	// running the whole workspace is the one answer they did not ask for.
	if (cli.packages !== undefined && !hasNonEmptyPackages(cli.packages)) {
		return { exitCode: 2, message: "Error: --packages names no packages.\n", ok: false };
	}

	return { ok: true };
}

/**
 * Resolve the selected packages to full `PackageInfo`, in the order the three
 * selection sources shadow each other: `--affected-since` replaces the set,
 * `--packages` narrows it, and a bare `--workspace` takes all of it.
 *
 * The `--affected-since` branch already carries directory +
 * `package.json#name` from turbo/nx, so it skips enumeration entirely.
 */
export function resolveWorkspacePackages(
	cli: CliOptions,
	workspaceRoot: string,
	{ childProcess, exclude, fileSystem, patterns }: WorkspacePackageSelection,
): Array<PackageInfo> {
	if (cli.affectedSince !== undefined) {
		return excludePackages(
			getAffectedPackages(workspaceRoot, cli.affectedSince, { childProcess, fileSystem }),
			workspaceRoot,
			exclude,
		);
	}

	if (cli.packages === undefined) {
		return enumerateWorkspacePackages(workspaceRoot, { exclude, fileSystem, patterns });
	}

	// One enumeration for the whole flag rather than one per name, which is what
	// `resolvePackages` being plural buys.
	//
	// No exclude here. Naming a package is asking for it, whatever a
	// workspace-wide default says.
	return resolvePackages(workspaceRoot, splitPackageNames(cli.packages), {
		fileSystem,
		patterns,
	});
}

export function buildWorkspaceCredentials(
	cli: CliOptions,
	runOptions: WorkspaceRunOptions,
): RunnerCredentials {
	return resolveCredentials({
		defaults: { placeId: runOptions.placeId, universeId: runOptions.universeId },
		envPrefix: "JEST_",
		overrides: { apiKey: cli.apiKey, placeId: cli.placeId, universeId: cli.universeId },
	});
}

/**
 * Which workspace-only flag routed this invocation here without `--workspace`.
 */
function namePresentWorkspaceFlag(cli: CliOptions): string {
	const present = WORKSPACE_ONLY_FLAGS.find((flag) => flag.isPresent(cli));
	// `isWorkspaceInvocation` is what routed the run here, and `--workspace` is
	// absent, so one of these is set — a miss means the two have drifted apart.
	assert(present !== undefined);
	return present.name;
}

function splitPackageNames(packages: string): Array<string> {
	return packages
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

function hasNonEmptyPackages(packages: string): boolean {
	return splitPackageNames(packages).length > 0;
}
