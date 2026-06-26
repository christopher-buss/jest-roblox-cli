import { resolveCredentials, type RunnerCredentials } from "@isentinel/roblox-runner";

import { isShardedParallel } from "../backends/interface.ts";
import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
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
		const flag = cli.affectedSince !== undefined ? "--affected-since" : "--packages";
		return {
			exitCode: 2,
			message: `Error: ${flag} requires --workspace.\n`,
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
 * so the only resolved-value invariant left is studio-cli's serial constraint:
 * it drives one Studio instance and cannot shard.
 */
export function assertWorkspaceRunOptions(
	runOptions: WorkspaceRunOptions,
): WorkspaceValidationResult {
	const { backend, parallel } = runOptions;
	if (backend === "studio-cli" && isShardedParallel(parallel)) {
		return {
			exitCode: 2,
			message:
				"Error: studio-cli backend is serial (one Studio instance) and cannot " +
				"shard; drop --parallel or set it to 1 for a --workspace run.\n",
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

function hasNonEmptyPackages(packages: string | undefined): boolean {
	if (packages === undefined) {
		return false;
	}

	return packages.split(",").some((name) => name.trim().length > 0);
}
