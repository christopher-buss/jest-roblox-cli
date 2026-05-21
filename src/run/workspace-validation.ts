import { resolveCredentials, type RunnerCredentials } from "@isentinel/roblox-runner";

import type { CliOptions, WorkspaceRunOptions } from "../config/schema.ts";
import { getAffectedPackages } from "../workspace/affected.ts";

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
 */
export function assertWorkspaceRunOptions(
	runOptions: WorkspaceRunOptions,
): WorkspaceValidationResult {
	if (runOptions.backend === "studio") {
		return {
			exitCode: 2,
			message: "Error: --workspace requires --backend open-cloud (Studio not supported).\n",
			ok: false,
		};
	}

	return { ok: true };
}

export function resolveWorkspacePackageNames(
	cli: CliOptions,
	workspaceRoot: string,
): Array<string> {
	if (cli.affectedSince !== undefined) {
		return getAffectedPackages(workspaceRoot, cli.affectedSince);
	}

	// validateBasicWorkspaceFlags guarantees cli.packages is defined when
	// affectedSince is undefined.
	// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed by validation
	return cli
		.packages!.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
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
