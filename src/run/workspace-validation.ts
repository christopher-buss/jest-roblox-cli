import { resolveCredentials, type RunnerCredentials } from "@isentinel/roblox-runner";

import assert from "node:assert";

import { isExplicitMultiShard } from "../backends/interface.ts";
import type { Backend, CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { getAffectedPackages } from "../workspace/affected.ts";
import {
	enumerateWorkspacePackages,
	type EnumerationOptions,
	excludePackages,
	listPackages,
	type PackageInfo,
} from "../workspace/package-resolver.ts";

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

	const vmParallelError = rejectVmParallel(cli);
	if (vmParallelError !== undefined) {
		return vmParallelError;
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
 * Checks the resolved WorkspaceRunOptions for invariants that depend on the
 * fully resolved values (CLI > per-package consensus > defaults).
 *
 * Every backend now runs workspace (studio-cli launches its own mega-place;
 * the attached `studio` backend runs against an open Studio for debugging),
 * so what is left are the two things a Studio transport cannot do: shard (it
 * drives one Studio instance — see {@link isExplicitMultiShard} for why
 * `"auto"` is not a conflict), and carry a bail back to the CLI.
 */
export function assertWorkspaceRunOptions({
	backend,
	bail,
	parallel,
}: WorkspaceRunOptions): WorkspaceValidationResult {
	if (backend === "studio-cli" && isExplicitMultiShard(parallel)) {
		return {
			exitCode: 2,
			// Source-agnostic: the count reaching here may come from a package
			// config rather than a flag, so "drop --parallel" would name a
			// remedy the user does not have.
			message:
				"Error: studio-cli backend is serial (one Studio instance) and cannot " +
				'shard; set parallel to 1 or "auto" for a --workspace run.\n',
			ok: false,
		};
	}

	// Bail lives in the staged materializer's entry loop, and travels back on
	// the Open Cloud task envelope (between parallel tasks, through a
	// MemoryStore signal map). The Studio plugin drives that same loop but its
	// protocol carries neither channel, so a Studio run would test every
	// package while the user waits for it to stop early. Teaching the plugin
	// protocol to report a bail is what would lift this, not anything here.
	if (bail && isStudioBackend(backend)) {
		return {
			exitCode: 2,
			message:
				"Error: --bail is Open Cloud only; a Studio backend runs every " +
				"package in the workspace regardless.\n",
			ok: false,
		};
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
	{ exclude, patterns }: EnumerationOptions = {},
): Array<PackageInfo> {
	if (cli.affectedSince !== undefined) {
		return excludePackages(
			getAffectedPackages(workspaceRoot, cli.affectedSince),
			workspaceRoot,
			exclude,
		);
	}

	if (cli.packages === undefined) {
		return enumerateWorkspacePackages(workspaceRoot, { exclude, patterns });
	}

	// One enumeration for the whole flag rather than one per name: a
	// `resolvePackage` per name walks the workspace root once per name.
	//
	// No exclude here. Naming a package is asking for it, whatever a
	// workspace-wide default says.
	const candidates = listPackages(workspaceRoot, patterns);
	return splitPackageNames(cli.packages).map((name) => pickPackage(candidates, name));
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
 * In-session parallelism splits the configs of ONE multi-project run across
 * Luau VMs, so a workspace run has nothing for it to split.
 *
 * A deliberate per-mode fork, against the package's cross-mode parity rule:
 * the two modes do not share an execution model here. Multi dispatches a
 * `configs` array to `Runner.runProjects`, which is what the VM hosts slice
 * up; workspace dispatches `workspace.entries` to
 * `EmbeddedRunner.runEmbedded`, which materializes a package from the
 * mega-place's stage, runs it, and resets the DataModel before the next one.
 * That materialize/run/reset cycle owns the DataModel for its package by
 * design, so overlapping packages would corrupt each other's staging rather
 * than merely contend for services. Rejecting the flag says so; leaving it
 * inert would read as a silent no-op.
 */
function rejectVmParallel(cli: CliOptions): undefined | WorkspaceValidationError {
	if (cli.experimentalVmParallel === undefined) {
		return undefined;
	}

	return {
		exitCode: 2,
		message:
			"Error: --experimental-vm-parallel is not supported in workspace mode; " +
			"it splits the configs of a single multi-project run.\n",
		ok: false,
	};
}

/**
 * Which workspace-only flag routed this invocation here without `--workspace`.
 */
function namePresentWorkspaceFlag(cli: CliOptions): string {
	const present = WORKSPACE_ONLY_FLAGS.find((flag) => flag.isPresent(cli));
	// `isWorkspaceInvocation` is what routed the run here, and `--workspace` is
	// absent, so one of these is set — a miss means the two have drifted apart.
	assert(present !== undefined, "a workspace-only flag routed this invocation");
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

/**
 * Whether this backend drives a Studio process rather than Open Cloud.
 *
 * Named as a deny-list on purpose: `"auto"` is the default and workspace mode
 * resolves it to Open Cloud without probing, so asking `!== "open-cloud"` would
 * catch the default invocation.
 */
function isStudioBackend(backend: Backend): boolean {
	return backend === "studio" || backend === "studio-cli";
}

function pickPackage(candidates: Array<PackageInfo>, name: string): PackageInfo {
	const found = candidates.find((candidate) => candidate.name === name);
	if (found !== undefined) {
		return found;
	}

	const names = candidates.map((candidate) => candidate.name).join(", ");
	throw new Error(`Package "${name}" not found in workspace. Available: ${names}`);
}
