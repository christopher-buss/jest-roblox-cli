import { resolveCredentials, type RunnerCredentials } from "@isentinel/roblox-runner";

import assert from "node:assert";

import { isExplicitMultiShard } from "../backends/interface.ts";
import type { Backend, CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { getAffectedPackages } from "../workspace/affected.ts";
import { type PackageInfo, resolvePackage } from "../workspace/package-resolver.ts";

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

	if (cli.affectedSince === undefined && !hasNonEmptyPackages(cli.packages)) {
		return {
			exitCode: 2,
			message: "Error: --workspace requires --packages or --affected-since.\n",
			ok: false,
		};
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
 * Resolve the affected/requested packages to full `PackageInfo`. The
 * `--affected-since` branch already carries directory + `package.json#name`
 * from turbo/nx, so it skips the `resolvePackage` round-trip; the `--packages`
 * branch resolves each comma-separated name against the workspace.
 */
export function resolveWorkspacePackages(
	cli: CliOptions,
	workspaceRoot: string,
	patterns?: Array<string>,
): Array<PackageInfo> {
	if (cli.affectedSince !== undefined) {
		return getAffectedPackages(workspaceRoot, cli.affectedSince);
	}

	// validateBasicWorkspaceFlags guarantees cli.packages is defined when
	// affectedSince is undefined.
	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed by validation
	const names = cli
		.packages!.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	return names.map((name) => resolvePackage(workspaceRoot, name, patterns));
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
	assert(present !== undefined, "a workspace-only flag routed this invocation");
	return present.name;
}

function hasNonEmptyPackages(packages: string | undefined): boolean {
	if (packages === undefined) {
		return false;
	}

	return packages.split(",").some((name) => name.trim().length > 0);
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
